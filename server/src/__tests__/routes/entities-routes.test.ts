// ─── /api/entities: the routes (21 Oct 2026) ─────────────────────────────────
// What each route accepts, whom it lets through, what it answers, and that a write tells the
// screens (through the fanout helpers) only once it has happened. The service is a stand-in; its
// rules are tested in services/entity/entity.service.test.ts, and the fanout's audience in
// entities-fanout.test.ts.

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
  // authenticate() checks the member is still active before any route runs.
  query: jest.fn().mockResolvedValue({ rows: [{ status: 'active', account_kind: 'member' }] }),
  transaction: jest.fn(),
  __esModule: true,
}));
const mockList = jest.fn();
const mockCreate = jest.fn();
const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockSetMembership = jest.fn();
const mockLeave = jest.fn();
const mockArchive = jest.fn();
const mockApprove = jest.fn();
const mockDecline = jest.fn();
const mockRemove = jest.fn();
const mockSavePicture = jest.fn();
const mockRemovePicture = jest.fn();
const mockPictureSource = jest.fn();
const mockPictureBlob = jest.fn();
jest.mock('../../services/entity/entity-pictures.service', () => ({
  saveEntityPicture: (...a: unknown[]) => mockSavePicture(...a),
  removeEntityPicture: (...a: unknown[]) => mockRemovePicture(...a),
  getEntityPictureSource: (...a: unknown[]) => mockPictureSource(...a),
  getEntityPictureBlob: (...a: unknown[]) => mockPictureBlob(...a),
  __esModule: true,
}));
jest.mock('../../services/entity/entity.service', () => ({
  approveMember: (...a: unknown[]) => mockApprove(...a),
  declineMember: (...a: unknown[]) => mockDecline(...a),
  removeMember: (...a: unknown[]) => mockRemove(...a),
  listEntities: (...a: unknown[]) => mockList(...a),
  createEntity: (...a: unknown[]) => mockCreate(...a),
  getEntity: (...a: unknown[]) => mockGet(...a),
  updateEntity: (...a: unknown[]) => mockUpdate(...a),
  setMyMembership: (...a: unknown[]) => mockSetMembership(...a),
  leaveEntity: (...a: unknown[]) => mockLeave(...a),
  archiveEntity: (...a: unknown[]) => mockArchive(...a),
  __esModule: true,
}));
const mockFanoutEntity = jest.fn().mockResolvedValue(undefined);
const mockFanoutProfile = jest.fn().mockResolvedValue(undefined);
const mockFanoutCircles = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/fanout', () => ({
  fanoutEntityChange: (...a: unknown[]) => mockFanoutEntity(...a),
  fanoutProfileChange: (...a: unknown[]) => mockFanoutProfile(...a),
  fanoutEntityCircles: (...a: unknown[]) => mockFanoutCircles(...a),
  __esModule: true,
}));

import entityRoutes from '../../routes/entities';
import { authenticate } from '../../middleware/auth';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import {
  bannerReadLimiter, entityCreateLimiter, entityReadLimiter, entityWriteLimiter, pictureSourceLimiter,
} from '../../middleware/rateLimit';
import { ConflictError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import { ENTITY_KINDS, ENTITY_ROLES, ErrorCodes } from '@rsn/shared';

const app = express();
app.use(express.json({ limit: '10mb' })); // as the server's own app (index.ts), so a picture reaches the route
app.use('/entities', entityRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

// Each describe signs in as its own member, so no block of tests uses up another's allowance.
const token = (sub: string, role = 'member') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const as = (sub: string, role = 'member') => ({ Authorization: `Bearer ${token(sub, role)}` });
const ID = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';
const OLD = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const notFound = () => new NotFoundError('Entity', ID, 'This entity could not be found.');
const services = [
  mockList, mockCreate, mockGet, mockUpdate, mockSetMembership, mockLeave, mockArchive, mockApprove, mockDecline, mockRemove,
  mockSavePicture, mockRemovePicture, mockPictureSource, mockPictureBlob,
];
const nothingCalled = () => {
  for (const m of services) expect(m).not.toHaveBeenCalled();
  expect(mockFanoutEntity).not.toHaveBeenCalled();
  expect(mockFanoutProfile).not.toHaveBeenCalled();
};

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue({ mine: [], others: [] });
  mockCreate.mockResolvedValue({ id: ID, companyUpdated: false });
  mockGet.mockResolvedValue({ entity: { id: ID }, people: [], myRole: null, canEdit: false });
  mockUpdate.mockResolvedValue(undefined);
  mockSetMembership.mockResolvedValue({ joined: true, role: 'employee', title: null, isAdmin: false, companyUpdated: false });
  mockLeave.mockResolvedValue({ left: true, archived: false });
  mockArchive.mockResolvedValue(undefined);
  mockApprove.mockResolvedValue({ companyUpdated: false });
  mockDecline.mockResolvedValue(undefined);
  mockRemove.mockResolvedValue(undefined);
  mockSavePicture.mockResolvedValue({ url: `https://api.example/api/entities/${ID}/logo?v=1` });
  mockRemovePicture.mockResolvedValue(undefined);
  mockPictureSource.mockResolvedValue({ image: null, crop: null });
  mockPictureBlob.mockResolvedValue(null);
});

describe('GET /entities', () => {
  const me = as('u-list');

  it('answers the viewer\'s own entities and others, and tells no screens (a read changes nothing)', async () => {
    const data = {
      mine: [{ id: ID, name: 'Acme Ltd', kind: 'company', location: null, peopleCount: 2, myRole: 'founder' }],
      others: [{ id: OLD, name: 'Beta Fund', kind: 'fund', location: 'Oslo', peopleCount: 5, myRole: null }],
    };
    mockList.mockResolvedValueOnce(data);
    const res = await request(app).get('/entities').set(me);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data });
    expect(mockList).toHaveBeenCalledWith('u-list', { q: undefined, limit: undefined });
    expect(mockFanoutEntity).not.toHaveBeenCalled();
  });

  it('passes the search and the limit on', async () => {
    await request(app).get('/entities').query({ q: 'acme', limit: '10' }).set(me);
    expect(mockList).toHaveBeenCalledWith('u-list', { q: 'acme', limit: 10 });
  });

  it('holds a limit above 30 to 30', async () => {
    await request(app).get('/entities').query({ limit: '500' }).set(me);
    expect(mockList).toHaveBeenCalledWith('u-list', { q: undefined, limit: 30 });
  });

  it.each([
    ['a limit of 0', { limit: '0' }],
    ['a limit that is not a number', { limit: 'lots' }],
    ['a search longer than 200 characters', { q: 'a'.repeat(201) }],
    ['two searches at once', 'q=a&q=b'],
  ])('refuses %s without calling the service', async (_what, q) => {
    const res = await request(app).get('/entities').query(q).set(me);
    expect(res.status).toBe(400);
    nothingCalled();
  });

  it('needs a signed-in member', async () => {
    expect((await request(app).get('/entities')).status).toBe(401);
    nothingCalled();
  });
});

describe('POST /entities', () => {
  const me = as('u-create');
  const body = { name: 'Acme Ltd', kind: 'company', role: 'founder' };

  it('creates, answers 201 with the id, then tells the creator\'s screens', async () => {
    const res = await request(app).post('/entities').set(me).send(body);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: { id: ID, companyUpdated: false } });
    expect(mockCreate).toHaveBeenCalledWith('u-create', { name: 'Acme Ltd', kind: 'company', role: 'founder' });
    expect(mockFanoutEntity).toHaveBeenCalledWith(ID, 'u-create', ['u-create']);
    expect(mockFanoutProfile).not.toHaveBeenCalled();
  });

  it('also tells the screens that show the creator\'s card when their empty company was filled in', async () => {
    mockCreate.mockResolvedValueOnce({ id: ID, companyUpdated: true });
    const res = await request(app).post('/entities').set(me).send(body);
    expect(res.body.data).toEqual({ id: ID, companyUpdated: true });
    expect(mockFanoutProfile).toHaveBeenCalledWith('u-create');
  });

  it('tidies what was typed: one space between words, blanks as null, a bare website given https://', async () => {
    await request(app).post('/entities').set(me).send({
      ...body, name: '  Acme    Ltd ', title: '  ', about: '  We build boats.  ', location: '', size: ' 11-50 ', website: ' acme.com ',
    });
    expect(mockCreate).toHaveBeenCalledWith('u-create', {
      name: 'Acme Ltd', kind: 'company', role: 'founder', title: null, about: 'We build boats.', location: null, size: '11-50',
      website: 'https://acme.com',
    });
  });

  it.each([...ENTITY_KINDS])('takes the kind "%s"', async (kind) => {
    expect((await request(app).post('/entities').set(as(`u-kinds-${kind}`)).send({ ...body, kind })).status).toBe(201);
  });

  it.each([...ENTITY_ROLES])('takes the role "%s"', async (role) => {
    expect((await request(app).post('/entities').set(as(`u-roles-${role}`)).send({ ...body, role })).status).toBe(201);
  });

  it.each([
    ['no name', { kind: 'company', role: 'founder' }, 'name'],
    ['a one-letter name', { ...body, name: ' A ' }, 'name'],
    ['a name of 201 characters', { ...body, name: 'A'.repeat(201) }, 'name'],
    ['an unknown kind', { ...body, kind: 'empire' }, 'kind'],
    ['no role', { name: 'Acme', kind: 'company' }, 'role'],
    ['an unknown role', { ...body, role: 'king' }, 'role'],
    ['a title of 121 characters', { ...body, title: 'T'.repeat(121) }, 'title'],
    ['an about of 2001 characters', { ...body, about: 'x'.repeat(2001) }, 'about'],
    ['a location of 201 characters', { ...body, location: 'L'.repeat(201) }, 'location'],
    ['a size of 41 characters', { ...body, size: 'S'.repeat(41) }, 'size'],
    ['a javascript: website', { ...body, website: 'javascript:alert(1)' }, 'website'],
    ['a website that is not an address', { ...body, website: 'not a site' }, 'website'],
    ['a website of 501 characters', { ...body, website: `https://acme.com/${'p'.repeat(484)}` }, 'website'],
  ])('refuses %s, naming the field, without calling the service', async (what, sent, field) => {
    // One member per case: creating has a small hourly allowance. A refused request no longer uses it
    // (see "uses none of the hourly allowance" below), but no case leans on another's.
    const res = await request(app).post('/entities').set(as(`u-refused-${what}`)).send(sent);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.body.error.details)).toContain(field);
    nothingCalled();
  });

  // Final review, 21 Oct 2026: the database counts characters, and the check counted UTF-16 units, so a
  // name of one emoji or one rare Chinese character got past it and the database answered with a 500.
  it.each([
    ['an emoji', '😀'],
    ['one character from CJK Extension B', '𠀀'],
  ])('refuses a name of one character beyond the basic plane (%s) in words, before the service', async (_what, name) => {
    const res = await request(app).post('/entities').set(as(`u-astral-${name.codePointAt(0)}`)).send({ ...body, name });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ name: ['Give the entity a name of at least 2 characters.'] });
    nothingCalled();
  });

  it('takes two such characters, and 200 of them, and refuses 201', async () => {
    const who = as('u-astral-lengths');
    expect((await request(app).post('/entities').set(who).send({ ...body, name: '😀😀' })).status).toBe(201);
    expect(mockCreate).toHaveBeenLastCalledWith('u-astral-lengths', expect.objectContaining({ name: '😀😀' }));
    expect((await request(app).post('/entities').set(who).send({ ...body, name: '𠀀'.repeat(200) })).status).toBe(201);
    const tooLong = await request(app).post('/entities').set(who).send({ ...body, name: '𠀀'.repeat(201) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.details).toEqual({ name: ['Keep the name to 200 characters.'] });
  });

  it('answers 409 with the id of the entity that already has the name, and tells no screens', async () => {
    mockCreate.mockRejectedValueOnce(
      new ConflictError(ErrorCodes.ENTITY_NAME_TAKEN, 'Acme Ltd is already on REASON.', { existingId: [OLD] }),
    );
    const res = await request(app).post('/entities').set(me).send(body);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'ENTITY_NAME_TAKEN', message: 'Acme Ltd is already on REASON.', details: { existingId: [OLD] } },
    });
    expect(mockFanoutEntity).not.toHaveBeenCalled();
  });

  it('needs a signed-in member', async () => {
    expect((await request(app).post('/entities').send(body)).status).toBe(401);
    nothingCalled();
  });
});

describe('GET /entities/:id', () => {
  const me = as('u-page');

  it('answers the page, judged for a member', async () => {
    const page = { entity: { id: ID, name: 'Acme Ltd' }, people: [], myRole: 'employee', canEdit: false };
    mockGet.mockResolvedValueOnce(page);
    const res = await request(app).get(`/entities/${ID}`).set(me);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: page });
    expect(mockGet).toHaveBeenCalledWith('u-page', ID, false);
    expect(mockFanoutEntity).not.toHaveBeenCalled();
  });

  it.each([['admin'], ['super_admin']])('tells the service a platform %s is looking', async (role) => {
    await request(app).get(`/entities/${ID}`).set(as('u-page-admin', role));
    expect(mockGet).toHaveBeenCalledWith('u-page-admin', ID, true);
  });

  it.each([['host'], ['pro'], ['founding_member']])('a %s is not a platform admin', async (role) => {
    await request(app).get(`/entities/${ID}`).set(as('u-page-role', role));
    expect(mockGet).toHaveBeenCalledWith('u-page-role', ID, false);
  });

  it('reads an id typed in capitals as the same entity', async () => {
    await request(app).get(`/entities/${ID.toUpperCase()}`).set(me);
    expect(mockGet).toHaveBeenCalledWith('u-page', ID, false);
  });

  it('refuses an id that is not an entity id, and a missing token', async () => {
    expect((await request(app).get('/entities/acme').set(me)).status).toBe(400);
    expect((await request(app).get(`/entities/${ID}`)).status).toBe(401);
    nothingCalled();
  });

  it('answers 404 for a missing or archived entity, with no data', async () => {
    mockGet.mockRejectedValueOnce(notFound());
    const res = await request(app).get(`/entities/${ID}`).set(me);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: { code: 'ENTITY_NOT_FOUND', message: 'This entity could not be found.' } });
  });
});

describe('PATCH /entities/:id', () => {
  const me = as('u-edit');

  it('edits, answers ok, then tells the entity\'s screens', async () => {
    const res = await request(app).patch(`/entities/${ID}`).set(me).send({ about: 'We build boats.', kind: 'startup' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { ok: true } });
    expect(mockUpdate).toHaveBeenCalledWith('u-edit', ID, { about: 'We build boats.', kind: 'startup' }, false);
    expect(mockFanoutEntity).toHaveBeenCalledWith(ID, 'u-edit');
  });

  it('clears a field sent as null or blank, and passes on only the fields sent', async () => {
    await request(app).patch(`/entities/${ID}`).set(me).send({ location: null, about: '   ', website: '' });
    expect(mockUpdate).toHaveBeenCalledWith('u-edit', ID, { location: null, about: null, website: null }, false);
  });

  it('tells the service a platform admin is editing', async () => {
    await request(app).patch(`/entities/${ID}`).set(as('u-edit-admin', 'admin')).send({ size: '200+' });
    expect(mockUpdate).toHaveBeenCalledWith('u-edit-admin', ID, { size: '200+' }, true);
  });

  it.each([
    ['nothing to change', {}],
    ['a name of null', { name: null }],
    ['a one-letter name', { name: 'A' }],
    ['a name of one emoji', { name: '🚀' }],
    ['a kind of null', { kind: null }],
    ['an unknown kind', { kind: 'empire' }],
    ['a javascript: website', { website: 'javascript:alert(1)' }],
    ['an about of 2001 characters', { about: 'x'.repeat(2001) }],
  ])('refuses %s without calling the service', async (_what, sent) => {
    const res = await request(app).patch(`/entities/${ID}`).set(as('u-edit-refused')).send(sent);
    expect(res.status).toBe(400);
    nothingCalled();
  });

  it('answers 403 for someone who is not one of its admins, and tells no screens', async () => {
    mockUpdate.mockRejectedValueOnce(new ForbiddenError("Only this entity's admins can change or archive it."));
    const res = await request(app).patch(`/entities/${ID}`).set(me).send({ about: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({ code: 'AUTH_FORBIDDEN', message: "Only this entity's admins can change or archive it." });
    expect(mockFanoutEntity).not.toHaveBeenCalled();
  });

  it('answers 404 and 409 as the service does, and tells no screens', async () => {
    mockUpdate.mockRejectedValueOnce(notFound());
    expect((await request(app).patch(`/entities/${ID}`).set(me).send({ about: 'x' })).status).toBe(404);
    mockUpdate.mockRejectedValueOnce(new ConflictError(ErrorCodes.ENTITY_NAME_TAKEN, 'Beta is already on REASON.', { existingId: [OLD] }));
    const clash = await request(app).patch(`/entities/${ID}`).set(me).send({ name: 'Beta' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.details).toEqual({ existingId: [OLD] });
    expect(mockFanoutEntity).not.toHaveBeenCalled();
  });
});

describe('POST /entities/:id/members (join, or change your own role)', () => {
  const me = as('u-join');

  it('joins, answers the link, then tells the entity\'s screens and the member\'s', async () => {
    const link = { joined: true, role: 'employee', title: 'Engineer', isAdmin: false, companyUpdated: false };
    mockSetMembership.mockResolvedValueOnce(link);
    const res = await request(app).post(`/entities/${ID}/members`).set(me).send({ role: 'employee', title: ' Engineer ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: link });
    expect(mockSetMembership).toHaveBeenCalledWith('u-join', ID, { role: 'employee', title: 'Engineer' }, false);
    expect(mockFanoutEntity).toHaveBeenCalledWith(ID, 'u-join', ['u-join']);
    expect(mockFanoutProfile).not.toHaveBeenCalled();
  });

  it('leaves the title out when none is sent (it stays as it was), and sends null for a blank one', async () => {
    await request(app).post(`/entities/${ID}/members`).set(me).send({ role: 'investor' });
    expect(mockSetMembership).toHaveBeenLastCalledWith('u-join', ID, { role: 'investor' }, false);
    await request(app).post(`/entities/${ID}/members`).set(me).send({ role: 'investor', title: '' });
    expect(mockSetMembership).toHaveBeenLastCalledWith('u-join', ID, { role: 'investor', title: null }, false);
  });

  it('answers a claim that waits (status pending), and tells the service when a platform admin claims (applied at once)', async () => {
    const waiting = { joined: true, role: 'employee', title: null, isAdmin: false, companyUpdated: false, status: 'pending', pendingChange: null };
    mockSetMembership.mockResolvedValueOnce(waiting);
    const res = await request(app).post(`/entities/${ID}/members`).set(me).send({ role: 'employee' });
    expect(res.body).toEqual({ success: true, data: waiting });
    expect(mockFanoutEntity).toHaveBeenCalledWith(ID, 'u-join', ['u-join']);
    await request(app).post(`/entities/${ID}/members`).set(as('u-join-admin', 'admin')).send({ role: 'investor' });
    expect(mockSetMembership).toHaveBeenLastCalledWith('u-join-admin', ID, { role: 'investor' }, true);
  });

  it('also tells the screens that show the member\'s card when their empty company was filled in', async () => {
    mockSetMembership.mockResolvedValueOnce({ joined: true, role: 'founder', title: null, isAdmin: false, companyUpdated: true });
    await request(app).post(`/entities/${ID}/members`).set(me).send({ role: 'founder' });
    expect(mockFanoutProfile).toHaveBeenCalledWith('u-join');
  });

  it.each([
    ['no role', {}],
    ['an unknown role', { role: 'king' }],
    ['a title of 121 characters', { role: 'employee', title: 'T'.repeat(121) }],
  ])('refuses %s without calling the service', async (_what, sent) => {
    expect((await request(app).post(`/entities/${ID}/members`).set(as('u-join-refused')).send(sent)).status).toBe(400);
    nothingCalled();
  });

  it('answers 404 for a missing or archived entity, and tells no screens', async () => {
    mockSetMembership.mockRejectedValueOnce(notFound());
    expect((await request(app).post(`/entities/${ID}/members`).set(me).send({ role: 'member' })).status).toBe(404);
    expect(mockFanoutEntity).not.toHaveBeenCalled();
  });
});

describe('DELETE /entities/:id/members/me (leave)', () => {
  const me = as('u-leave');

  it('leaves, answers what happened, then tells the entity\'s screens and the member\'s', async () => {
    mockLeave.mockResolvedValueOnce({ left: true, archived: true });
    const res = await request(app).delete(`/entities/${ID}/members/me`).set(me);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { left: true, archived: true } });
    expect(mockLeave).toHaveBeenCalledWith('u-leave', ID);
    expect(mockFanoutEntity).toHaveBeenCalledWith(ID, 'u-leave', ['u-leave']);
  });

  it('tells no screens when the member was not linked to it (nothing changed)', async () => {
    mockLeave.mockResolvedValueOnce({ left: false, archived: false });
    const res = await request(app).delete(`/entities/${ID}/members/me`).set(me);
    expect(res.body).toEqual({ success: true, data: { left: false, archived: false } });
    expect(mockFanoutEntity).not.toHaveBeenCalled();
  });

  it('answers 404 for a missing or archived entity, and refuses a bad id or no token', async () => {
    mockLeave.mockRejectedValueOnce(notFound());
    expect((await request(app).delete(`/entities/${ID}/members/me`).set(me)).status).toBe(404);
    expect((await request(app).delete('/entities/acme/members/me').set(me)).status).toBe(400);
    expect((await request(app).delete(`/entities/${ID}/members/me`)).status).toBe(401);
    expect(mockFanoutEntity).not.toHaveBeenCalled();
  });
});

describe('DELETE /entities/:id (archive)', () => {
  const me = as('u-archive');

  it('archives, answers ok, then tells the entity\'s screens', async () => {
    const res = await request(app).delete(`/entities/${ID}`).set(me);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { ok: true } });
    expect(mockArchive).toHaveBeenCalledWith('u-archive', ID, false);
    expect(mockFanoutEntity).toHaveBeenCalledWith(ID, 'u-archive');
  });

  it('tells the service a platform admin is archiving', async () => {
    await request(app).delete(`/entities/${ID}`).set(as('u-archive-admin', 'super_admin'));
    expect(mockArchive).toHaveBeenCalledWith('u-archive-admin', ID, true);
  });

  it('answers 403 and 404 as the service does, and tells no screens', async () => {
    mockArchive.mockRejectedValueOnce(new ForbiddenError("Only this entity's admins can change or archive it."));
    expect((await request(app).delete(`/entities/${ID}`).set(me)).status).toBe(403);
    mockArchive.mockRejectedValueOnce(notFound());
    expect((await request(app).delete(`/entities/${ID}`).set(me)).status).toBe(404);
    expect(mockFanoutEntity).not.toHaveBeenCalled();
  });

  it('refuses a bad id or no token', async () => {
    expect((await request(app).delete('/entities/not-an-id').set(me)).status).toBe(400);
    expect((await request(app).delete(`/entities/${ID}`)).status).toBe(401);
    nothingCalled();
  });
});

describe('the routes are rate limited', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
  // What a route runs, in order, read from the router itself.
  const handlersOf = (method: string, path: string) =>
    (entityRoutes as unknown as { stack: Layer[] }).stack
      .filter((layer) => layer.route?.path === path && layer.route.methods[method])
      .flatMap((layer) => layer.route!.stack.map((s) => s.handle));

  it.each([
    ['get', '/', entityReadLimiter],
    ['get', '/:id', entityReadLimiter],
    ['post', '/', entityCreateLimiter],
    ['patch', '/:id', entityWriteLimiter],
    ['delete', '/:id', entityWriteLimiter],
    ['post', '/:id/members', entityWriteLimiter],
    ['delete', '/:id/members/me', entityWriteLimiter],
    ['post', '/:id/members/:userId/approve', entityWriteLimiter],
    ['post', '/:id/members/:userId/decline', entityWriteLimiter],
    ['delete', '/:id/members/:userId', entityWriteLimiter],
    ['put', '/:id/logo', entityWriteLimiter],
    ['delete', '/:id/logo', entityWriteLimiter],
    ['put', '/:id/banner', entityWriteLimiter],
    ['delete', '/:id/banner', entityWriteLimiter],
    ['get', '/:id/logo/source', pictureSourceLimiter],
    ['get', '/:id/banner/source', pictureSourceLimiter],
  ])('%s %s carries its limiter, after authenticate and ahead of its handler', (method, path, limiter) => {
    const handlers = handlersOf(method, path);
    expect(handlers.length).toBeGreaterThan(2); // the route exists
    const signedIn = handlers.indexOf(authenticate);
    const at = handlers.indexOf(limiter);
    expect(signedIn).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(signedIn);
    expect(at).toBeLessThan(handlers.length - 1);
  });

  it('refuses the 11th new entity in an hour with a friendly 429, for that member only', async () => {
    const busy = as('u-busy');
    for (let i = 0; i < 10; i += 1) {
      expect((await request(app).post('/entities').set(busy).send({ name: `Acme ${i}`, kind: 'company', role: 'founder' })).status).toBe(201);
    }
    mockCreate.mockClear();
    const refused = await request(app).post('/entities').set(busy).send({ name: 'Acme 10', kind: 'company', role: 'founder' });
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ success: false, error: { code: 'RATE_LIMITED', message: 'You have added a lot of entities this hour. Try again later.' } });
    expect(mockCreate).not.toHaveBeenCalled();
    // Someone else can still create, and this member can still read and join.
    expect((await request(app).post('/entities').set(as('u-calm')).send({ name: 'Calm', kind: 'company', role: 'founder' })).status).toBe(201);
    expect((await request(app).get('/entities').set(busy)).status).toBe(200);
    expect((await request(app).post(`/entities/${ID}/members`).set(busy).send({ role: 'member' })).status).toBe(200);
  });

  // Final review, 21 Oct 2026: the allowance counted refusals, so trying the name-clash flow a few times
  // ("Acme is already on REASON", then a typo) soon said "You have added a lot of entities this hour"
  // to someone who had added none. Only an entity that was made counts now.
  it('a create that is refused (a name taken, a name too short) uses none of the hourly allowance', async () => {
    const tester = as('u-clash-tester');
    for (let i = 0; i < 12; i += 1) {
      mockCreate.mockRejectedValueOnce(
        new ConflictError(ErrorCodes.ENTITY_NAME_TAKEN, 'Acme Ltd is already on REASON.', { existingId: [OLD] }),
      );
      expect((await request(app).post('/entities').set(tester).send({ name: 'Acme Ltd', kind: 'company', role: 'founder' })).status).toBe(409);
      expect((await request(app).post('/entities').set(tester).send({ name: 'A', kind: 'company', role: 'founder' })).status).toBe(400);
    }
    for (let i = 0; i < 10; i += 1) {
      expect((await request(app).post('/entities').set(tester).send({ name: `Tested ${i}`, kind: 'company', role: 'founder' })).status).toBe(201);
    }
    const refused = await request(app).post('/entities').set(tester).send({ name: 'Tested 10', kind: 'company', role: 'founder' });
    expect(refused.status).toBe(429);
    expect(refused.body.error.message).toBe('You have added a lot of entities this hour. Try again later.');
  });
});

// ── 30 Oct review (T15): the admins' answers, the pictures, and production's shapes ─────────────────────────

const OTHER = '9c8b7a6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';

describe('POST /entities/:id/members/:userId/approve | decline, DELETE /entities/:id/members/:userId', () => {
  const me = as('u-answer');

  it('approves, answers ok, then tells the entity\'s screens and the member\'s', async () => {
    const res = await request(app).post(`/entities/${ID}/members/${OTHER}/approve`).set(me);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { ok: true } });
    expect(mockApprove).toHaveBeenCalledWith('u-answer', ID, OTHER, false);
    expect(mockFanoutEntity).toHaveBeenCalledWith(ID, 'u-answer', [OTHER]);
    expect(mockFanoutProfile).not.toHaveBeenCalled();
  });

  it('also tells the screens that show the member\'s card when approval filled their empty company', async () => {
    mockApprove.mockResolvedValueOnce({ companyUpdated: true });
    await request(app).post(`/entities/${ID}/members/${OTHER}/approve`).set(me);
    expect(mockFanoutProfile).toHaveBeenCalledWith(OTHER);
  });

  it('declines and removes, telling the same screens, and lower-cases an id sent in capitals', async () => {
    await request(app).post(`/entities/${ID}/members/${OTHER.toUpperCase()}/decline`).set(me);
    expect(mockDecline).toHaveBeenCalledWith('u-answer', ID, OTHER, false);
    expect(mockFanoutEntity).toHaveBeenLastCalledWith(ID, 'u-answer', [OTHER]);
    await request(app).delete(`/entities/${ID}/members/${OTHER}`).set(as('u-answer-admin', 'admin'));
    expect(mockRemove).toHaveBeenCalledWith('u-answer-admin', ID, OTHER, true);
    expect(mockFanoutEntity).toHaveBeenLastCalledWith(ID, 'u-answer-admin', [OTHER]);
  });

  it('still leaves through /members/me: "me" never reaches the remove route', async () => {
    await request(app).delete(`/entities/${ID}/members/me`).set(me);
    expect(mockLeave).toHaveBeenCalledWith('u-answer', ID);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('answers the service\'s 403, 404 and 409 in words, and tells no screens', async () => {
    mockApprove.mockRejectedValueOnce(new ForbiddenError("Only this entity's admins can change or archive it."));
    expect((await request(app).post(`/entities/${ID}/members/${OTHER}/approve`).set(me)).status).toBe(403);
    mockDecline.mockRejectedValueOnce(new NotFoundError('EntityRequest', undefined, 'This request has already been answered.'));
    const gone = await request(app).post(`/entities/${ID}/members/${OTHER}/decline`).set(me);
    expect(gone.status).toBe(404);
    expect(gone.body.error.message).toBe('This request has already been answered.');
    mockRemove.mockRejectedValueOnce(new ConflictError(ErrorCodes.ENTITY_LAST_ADMIN, "This is the entity's last admin, so they can't be removed."));
    const last = await request(app).delete(`/entities/${ID}/members/${OTHER}`).set(me);
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('ENTITY_LAST_ADMIN');
    expect(mockFanoutEntity).not.toHaveBeenCalled();
  });

  it('refuses a bad member id or no token without calling the service', async () => {
    expect((await request(app).post(`/entities/${ID}/members/not-an-id/approve`).set(me)).status).toBe(400);
    expect((await request(app).delete(`/entities/${ID}/members/12345`).set(me)).status).toBe(400);
    expect((await request(app).post(`/entities/${ID}/members/${OTHER}/approve`)).status).toBe(401);
    nothingCalled();
  });
});

describe('PUT / DELETE /entities/:id/logo and /banner, GET …/source', () => {
  const me = as('u-pictures');
  const image = 'data:image/png;base64,iVBORw0KGgo=';

  it.each([['logo', 'logoUrl'], ['banner', 'bannerUrl']] as const)('saves the %s, answers its address, then tells the entity\'s screens', async (kind, field) => {
    mockSavePicture.mockResolvedValueOnce({ url: `https://api.example/api/entities/${ID}/${kind}?v=5` });
    const res = await request(app).put(`/entities/${ID}/${kind}`).set(me).send({ image, crop: { x: 0.5, y: 0.4, zoom: 2 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { [field]: `https://api.example/api/entities/${ID}/${kind}?v=5` } });
    expect(mockSavePicture).toHaveBeenCalledWith('u-pictures', ID, kind, { image, crop: { x: 0.5, y: 0.4, zoom: 2 } }, false);
    expect(mockFanoutEntity).toHaveBeenCalledWith(ID, 'u-pictures');
  });

  it('places the kept picture again with only a crop, and removes a picture', async () => {
    await request(app).put(`/entities/${ID}/logo`).set(me).send({ crop: { x: 0.2, y: 0.5, zoom: 1 } });
    expect(mockSavePicture).toHaveBeenCalledWith('u-pictures', ID, 'logo', { image: undefined, crop: { x: 0.2, y: 0.5, zoom: 1 } }, false);
    const res = await request(app).delete(`/entities/${ID}/banner`).set(as('u-pictures-admin', 'admin'));
    expect(res.body).toEqual({ success: true, data: { bannerUrl: null } });
    expect(mockRemovePicture).toHaveBeenCalledWith('u-pictures-admin', ID, 'banner', true);
  });

  it.each([
    ['nothing', {}],
    ['a crop out of range', { crop: { x: 2, y: 0.5, zoom: 1 } }],
    ['a zoom of 9', { crop: { x: 0.5, y: 0.5, zoom: 9 } }],
    ['a crop with more in it', { crop: { x: 0.5, y: 0.5, zoom: 1, rotate: 90 } }],
    ['a picture far past 3 MB', { image: `data:image/png;base64,${'A'.repeat(4_300_000)}` }],
  ])('refuses %s without calling the service', async (_what, sent) => {
    const res = await request(app).put(`/entities/${ID}/logo`).set(as('u-pictures-refused')).send(sent);
    expect(res.status).toBe(400);
    nothingCalled();
  });

  it('names the logo in its refusals', async () => {
    const none = await request(app).put(`/entities/${ID}/logo`).set(as('u-pictures-words')).send({});
    expect(JSON.stringify(none.body)).toContain('Choose a picture for the logo.');
    const big = await request(app).put(`/entities/${ID}/banner`).set(as('u-pictures-words'))
      .send({ image: `data:image/png;base64,${'A'.repeat(4_300_000)}` });
    expect(JSON.stringify(big.body)).toContain('The banner must be 3 MB or smaller.');
  });

  it('answers the service\'s 403 for someone who is not an admin, and tells no screens', async () => {
    mockSavePicture.mockRejectedValueOnce(new ForbiddenError("Only this entity's admins can change or archive it."));
    expect((await request(app).put(`/entities/${ID}/logo`).set(me).send({ image })).status).toBe(403);
    expect(mockFanoutEntity).not.toHaveBeenCalled();
  });

  it('hands the editor the kept picture, for the people who may change it', async () => {
    mockPictureSource.mockResolvedValueOnce({ image, crop: { x: 0.5, y: 0.5, zoom: 1 } });
    const res = await request(app).get(`/entities/${ID}/logo/source`).set(me);
    expect(res.body).toEqual({ success: true, data: { image, crop: { x: 0.5, y: 0.5, zoom: 1 } } });
    expect(mockPictureSource).toHaveBeenCalledWith('u-pictures', ID, 'logo', false);
    expect((await request(app).get(`/entities/${ID}/logo/source`)).status).toBe(401);
  });
});

describe('GET /entities/:id/logo and /banner (public)', () => {
  it('serves the picture with no token, as a picture only, cached for a day', async () => {
    mockPictureBlob.mockResolvedValueOnce({ blob: Buffer.from([0xff, 0xd8, 0xff, 0x00]), contentType: 'image/jpeg' });
    const res = await request(app).get(`/entities/${ID}/logo?v=123`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(mockPictureBlob).toHaveBeenCalledWith(ID, 'logo');
  });

  it('answers an empty 404 for no picture or an archived entity, and 400 for a bad id', async () => {
    const res = await request(app).get(`/entities/${ID}/banner`);
    expect(res.status).toBe(404);
    expect(res.text).toBe('');
    expect((await request(app).get('/entities/acme/logo')).status).toBe(400);
  });

  it.each([['get', '/:id/logo'], ['get', '/:id/banner']])('%s %s is limited per address, with no sign-in', (method, routePath) => {
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
    const handlers = (entityRoutes as unknown as { stack: Layer[] }).stack
      .filter((layer) => layer.route?.path === routePath && layer.route.methods[method])
      .flatMap((layer) => layer.route!.stack.map((s) => s.handle));
    expect(handlers[0]).toBe(bannerReadLimiter);
    expect(handlers).not.toContain(authenticate);
  });
});

// Production's client (origin/main's client/) never calls /entities (audit 05 §0.1); the preview's does. Every field
// the routes answered before T15 is still answered, with the same name and meaning; the new ones are added beside them.
describe("production's shapes are unchanged (additive only)", () => {
  it('the join body the screens sent before is still accepted, and its answer keeps every old field', async () => {
    const old = { joined: true, role: 'employee', title: 'Engineer', isAdmin: false, companyUpdated: false };
    mockSetMembership.mockResolvedValueOnce({ ...old, status: 'pending', pendingChange: null });
    const res = await request(app).post(`/entities/${ID}/members`).set(as('u-compat')).send({ role: 'employee', title: 'Engineer' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject(old);
  });

  it('the page keeps every old field beside the new ones', async () => {
    const entity = { id: ID, name: 'Acme', kind: 'company', about: null, location: null, size: null, website: null, peopleCount: 1, createdAt: 'x', updatedAt: 'y' };
    mockGet.mockResolvedValueOnce({
      entity: { ...entity, logoUrl: null, bannerUrl: null }, people: [], myRole: null, canEdit: false,
      myStatus: null, myPendingChange: null, circles: [],
    });
    const page = await request(app).get(`/entities/${ID}`).set(as('u-compat'));
    expect(page.body.data).toMatchObject({ entity, people: [], myRole: null, canEdit: false });
    expect(Object.keys(page.body.data).sort()).toEqual(['canEdit', 'circles', 'entity', 'myPendingChange', 'myRole', 'myStatus', 'people']);
  });
});

// T15 review M2: the writes that change what a circle page shows of an entity (its name, kind, logo, or it leaving
// with an archive) also tell the circles it is linked to; claims, answers and removals do not.
describe('the circle pages that list an entity are told when what they show changes (review M2)', () => {
  const me = as('u-circles');
  it.each([
    ['an edit', () => request(app).patch(`/entities/${ID}`).set(me).send({ name: 'Acme Boats' })],
    ['an archive', () => request(app).delete(`/entities/${ID}`).set(me)],
    ['a new logo', () => request(app).put(`/entities/${ID}/logo`).set(me).send({ crop: { x: 0.5, y: 0.5, zoom: 1 } })],
    ['a removed banner', () => request(app).delete(`/entities/${ID}/banner`).set(me)],
  ])('%s', async (_what, send) => {
    expect((await send()).status).toBe(200);
    expect(mockFanoutCircles).toHaveBeenCalledWith(ID);
  });

  it('a leave that archives it tells them; a leave that does not, and claims and answers, do not', async () => {
    mockLeave.mockResolvedValueOnce({ left: true, archived: false });
    await request(app).delete(`/entities/${ID}/members/me`).set(me);
    await request(app).post(`/entities/${ID}/members`).set(me).send({ role: 'fan' });
    await request(app).post(`/entities/${ID}/members/${OTHER}/approve`).set(me);
    await request(app).delete(`/entities/${ID}/members/${OTHER}`).set(me);
    expect(mockFanoutCircles).not.toHaveBeenCalled();
    mockLeave.mockResolvedValueOnce({ left: true, archived: true });
    await request(app).delete(`/entities/${ID}/members/me`).set(me);
    expect(mockFanoutCircles).toHaveBeenCalledWith(ID);
  });

  it('a refused edit tells nobody', async () => {
    mockUpdate.mockRejectedValueOnce(new ForbiddenError("Only this entity's admins can change or archive it."));
    expect((await request(app).patch(`/entities/${ID}`).set(me).send({ about: 'x' })).status).toBe(403);
    expect(mockFanoutCircles).not.toHaveBeenCalled();
  });
});

// T15 client review item 5 (measured on the local stack, 2 Nov 2026): an admin working through the Requests panel with
// the Entities list and their profile open in two more tabs makes 4 entity reads per approval (every entity screen of
// theirs is told and reads again). At 60 a minute the 15th approval in a row met a 429 and the panel froze on people
// already approved. Reads are allowed 120 a minute per member, as the picture reads are.
describe('the entity read allowance (T15 client review item 5)', () => {
  it('lets one member read 120 times in a minute, and refuses the 121st in words', async () => {
    const busy = as('u-reads-120');
    for (let i = 0; i < 120; i += 1) {
      const res = await request(app).get('/entities').set(busy);
      expect({ i, status: res.status }).toEqual({ i, status: 200 });
    }
    const refused = await request(app).get('/entities').set(busy);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toEqual({ code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' });
    // Someone else still reads.
    expect((await request(app).get('/entities').set(as('u-reads-other'))).status).toBe(200);
  });
});
