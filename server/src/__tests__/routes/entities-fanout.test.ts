// ─── Entities: who is told, and what (21 Oct 2026) ───────────────────────────
// Every write to an entity tells its people (as they are after the write), the member who acted,
// and the member whose link changed. Each recipient hears the entity's own tag and their own list
// tag; when a member's link changes, everyone told also hears that member's list tag, so a profile
// that lists the member's entities redraws for the people who share the entity with them. A member's
// empty company filled in from their entity also reaches the screens that show their card: their
// own, and their pods' member lists (the audience of a saved profile).
//
// These tests go through each route to the emit: the real routes and the real fanout helpers, a fake
// database that answers by WHO the SQL asks for, and the emit boundary recorded. The entity service
// is a stand-in; its rules are tested in services/entity/entity.service.test.ts.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: { jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
  __esModule: true,
}));
const mockLoggerWarn = jest.fn();
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: (...args: unknown[]) => mockLoggerWarn(...args), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../services/entity/entity.service');
jest.mock('../../services/entity/entity-pictures.service');

const mockIo = { name: 'the socket server' };
const mockEmitEntities = jest.fn();
jest.mock('../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
  getRealtimeIo: () => mockIo,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));

import * as entityService from '../../services/entity/entity.service';
import * as entityPictures from '../../services/entity/entity-pictures.service';
import entityRoutes from '../../routes/entities';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { ForbiddenError } from '../../middleware/errors';
import { E } from '../../realtime/entities';

const ENTITY = '8d5e0b64-1c1f-4c3f-9d1e-6a5d0f3b2a11';
const OTHER_ENTITY = '1f4a9c7e-3b2d-4e65-8a90-5d7c2b1e0f33';
const POD = '3a7c1f52-5b9e-4f0a-8e0d-2c4b6d8f1a22';

const ADMIN = 'user-admin';        // the entity's admin
const COLLEAGUE = 'user-colleague'; // linked to the entity
const JOINER = 'user-joiner';       // links themselves to it in the test
const PLATFORM = 'user-platform';   // a platform admin, not linked to it
const PODMATE = 'user-podmate';     // shares a pod with the joiner, nothing to do with the entity
const OUTSIDER = 'user-outsider';   // linked to another entity only
// T15 review M2: two circles the entity is linked to, and people who have their pages open.
const CIRCLE_A = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const CIRCLE_B = '0f9e8d7c-6b5a-4f3e-9d2c-1b0a9f8e7d6c';
const CIRCLE_MEMBER = 'user-circle-member';       // in both circles, nothing to do with the entity
const OTHER_CIRCLE_PERSON = 'user-circle-b-only'; // in circle B only

/** Who is linked to which entity, as the fake database holds it; a test changes it to mirror its write. */
let people: Record<string, string[]>;
/** T15 review M2: whether the entity is linked to the two circles (only that block's tests link it). */
let linkedToCircles = false;

beforeEach(() => {
  jest.clearAllMocks();
  people = { [ENTITY]: [ADMIN, COLLEAGUE], [OTHER_ENTITY]: [OUTSIDER] };
  linkedToCircles = false;
  mockEmitEntities.mockResolvedValue(undefined);
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ');
    if (/SELECT status FROM users/.test(text)) return { rows: [{ status: 'active' }] }; // authenticate
    // T15: the live links only (active and pending); a declined or removed person is told only as a changed user.
    if (/SELECT m\.user_id FROM entity_members m WHERE m\.entity_id = \$1 AND m\.status IN \('active', 'pending'\)/.test(text)) {
      return { rows: (people[String(params[0])] ?? []).map(user_id => ({ user_id })) };
    }
    // T15 review M2: the people of each circle the entity is linked to (members and creator, active accounts).
    if (/FROM circle_entities ce/.test(text)) {
      if (params[0] !== ENTITY || !linkedToCircles) return { rows: [] };
      return { rows: [
        { circle_id: CIRCLE_A, user_id: CIRCLE_MEMBER }, { circle_id: CIRCLE_A, user_id: ADMIN },
        { circle_id: CIRCLE_B, user_id: CIRCLE_MEMBER }, { circle_id: CIRCLE_B, user_id: OTHER_CIRCLE_PERSON },
      ] };
    }
    if (/SELECT pod_id FROM pod_members WHERE user_id = \$1 AND status = 'active'/.test(text)) {
      return { rows: params[0] === JOINER ? [{ pod_id: POD }] : [] };
    }
    if (/SELECT user_id FROM pod_members WHERE pod_id = \$1/.test(text)) {
      return { rows: params[0] === POD ? [{ user_id: JOINER }, { user_id: PODMATE }] : [] };
    }
    return { rows: [] };
  });
  jest.mocked(entityService.createEntity).mockResolvedValue({ id: ENTITY, companyUpdated: false });
  jest.mocked(entityService.updateEntity).mockResolvedValue(undefined);
  jest.mocked(entityService.archiveEntity).mockResolvedValue(undefined);
  jest.mocked(entityService.setMyMembership).mockResolvedValue({
    joined: true, role: 'employee', title: null, isAdmin: false, companyUpdated: false, status: 'pending', pendingChange: null,
  });
  jest.mocked(entityService.approveMember).mockResolvedValue({ companyUpdated: false });
  jest.mocked(entityService.declineMember).mockResolvedValue(undefined);
  jest.mocked(entityService.removeMember).mockResolvedValue(undefined);
  jest.mocked(entityPictures.saveEntityPicture).mockResolvedValue({ url: `https://api.example/api/entities/${ENTITY}/logo?v=1` });
  jest.mocked(entityPictures.removeEntityPicture).mockResolvedValue(undefined);
  jest.mocked(entityService.leaveEntity).mockResolvedValue({ left: true, archived: false });
});

const app = express();
app.use(express.json());
app.use('/entities', entityRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const as = (sub: string, role = 'member') =>
  ({ Authorization: `Bearer ${jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}` });

/** The fanout runs after the answer is sent; let it finish. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 20));

type Emit = [unknown, string[], string[]];
const emits = () => mockEmitEntities.mock.calls as Emit[];

/** Every emit, as recipient → the tags they were sent. */
function heard(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [io, recipients, tags] of emits()) {
    expect(io).toBe(mockIo);
    for (const r of recipients) out[r] = [...(out[r] ?? []), ...tags].sort();
  }
  return out;
}
const sorted = (tags: string[]) => [...tags].sort();

describe('who hears an entity change', () => {
  it('a new entity: only its creator, who hears the entity and their own list', async () => {
    people = { [ENTITY]: [JOINER] }; // the creator's link, as the service just wrote it
    const res = await request(app).post('/entities').set(as(JOINER)).send({ name: 'Acme Ltd', kind: 'company', role: 'investor' });
    expect(res.status).toBe(201);
    await settle();
    expect(heard()).toEqual({ [JOINER]: sorted([E.entity(ENTITY), E.userEntities(JOINER)]) });
  });

  it('a join: every person linked to it and the joiner hear the entity, their own list and the joiner\'s', async () => {
    people[ENTITY] = [ADMIN, COLLEAGUE, JOINER];
    expect((await request(app).post(`/entities/${ENTITY}/members`).set(as(JOINER)).send({ role: 'employee' })).status).toBe(200);
    await settle();
    expect(heard()).toEqual({
      [ADMIN]: sorted([E.entity(ENTITY), E.userEntities(ADMIN), E.userEntities(JOINER)]),
      [COLLEAGUE]: sorted([E.entity(ENTITY), E.userEntities(COLLEAGUE), E.userEntities(JOINER)]),
      [JOINER]: sorted([E.entity(ENTITY), E.userEntities(JOINER)]),
    });
    // One emit per person, each carrying that person's own list tag, not everyone's.
    expect(emits().every(([, recipients]) => recipients.length === 1)).toBe(true);
    expect(emits()).toHaveLength(3);
  });

  it('a leave: the member who left is told too, though they are no longer among its people', async () => {
    people[ENTITY] = [ADMIN]; // COLLEAGUE has just left
    expect((await request(app).delete(`/entities/${ENTITY}/members/me`).set(as(COLLEAGUE))).status).toBe(200);
    await settle();
    expect(heard()).toEqual({
      [ADMIN]: sorted([E.entity(ENTITY), E.userEntities(ADMIN), E.userEntities(COLLEAGUE)]),
      [COLLEAGUE]: sorted([E.entity(ENTITY), E.userEntities(COLLEAGUE)]),
    });
  });

  it('the last person leaving (the entity is archived with them) still tells them', async () => {
    people[ENTITY] = [];
    jest.mocked(entityService.leaveEntity).mockResolvedValueOnce({ left: true, archived: true });
    await request(app).delete(`/entities/${ENTITY}/members/me`).set(as(ADMIN));
    await settle();
    expect(heard()).toEqual({ [ADMIN]: sorted([E.entity(ENTITY), E.userEntities(ADMIN)]) });
  });

  it('an edit by a platform admin who is not linked to it: its people and the admin, each with their own list only', async () => {
    expect((await request(app).patch(`/entities/${ENTITY}`).set(as(PLATFORM, 'admin')).send({ about: 'Boats.' })).status).toBe(200);
    await settle();
    expect(heard()).toEqual({
      [ADMIN]: sorted([E.entity(ENTITY), E.userEntities(ADMIN)]),
      [COLLEAGUE]: sorted([E.entity(ENTITY), E.userEntities(COLLEAGUE)]),
      [PLATFORM]: sorted([E.entity(ENTITY), E.userEntities(PLATFORM)]),
    });
  });

  it('an archive: everyone still linked to it (an archive keeps the links) and the admin who did it', async () => {
    expect((await request(app).delete(`/entities/${ENTITY}`).set(as(ADMIN))).status).toBe(200);
    await settle();
    expect(heard()).toEqual({
      [ADMIN]: sorted([E.entity(ENTITY), E.userEntities(ADMIN)]),
      [COLLEAGUE]: sorted([E.entity(ENTITY), E.userEntities(COLLEAGUE)]),
    });
  });

  it('never tells anyone linked only to another entity, nor anyone about another entity', async () => {
    people[ENTITY] = [ADMIN, COLLEAGUE, JOINER];
    await request(app).post(`/entities/${ENTITY}/members`).set(as(JOINER)).send({ role: 'fan' });
    await request(app).patch(`/entities/${ENTITY}`).set(as(ADMIN)).send({ size: '11-50' });
    await settle();
    const all = heard();
    expect(all).not.toHaveProperty(OUTSIDER);
    expect(Object.values(all).flat().some(tag => tag.includes(OTHER_ENTITY) || tag.includes(OUTSIDER))).toBe(false);
  });

  it('a member\'s company filled in from the entity also reaches their own card and their pods\' member lists', async () => {
    people[ENTITY] = [ADMIN, COLLEAGUE, JOINER];
    jest.mocked(entityService.setMyMembership).mockResolvedValueOnce({
      joined: true, role: 'founder', title: null, isAdmin: false, companyUpdated: true, status: 'active', pendingChange: null,
    });
    await request(app).post(`/entities/${ENTITY}/members`).set(as(JOINER)).send({ role: 'founder' });
    await settle();
    const all = heard();
    expect(all[JOINER]).toEqual(expect.arrayContaining([E.user(JOINER), E.pod(POD), E.podMembers(POD), E.entity(ENTITY), E.userEntities(JOINER)]));
    expect(all[PODMATE]).toEqual(expect.arrayContaining([E.pod(POD), E.podMembers(POD)]));
    expect(all[PODMATE]).not.toContain(E.entity(ENTITY));
    expect(all[ADMIN]).not.toContain(E.user(JOINER));
  });
});

// T15 (30 Oct review, 7.2): a claim waits, and the admins answer it. Each answer reaches the entity's live people, the
// admin who answered and the member it was about, whatever their link now is, so the Requests panel, the People list
// and the member's own "Waiting for approval" all flip without a reload.
describe('who hears a claim and its answer (T15)', () => {
  it('a claim that waits: the people and the claimant (now a pending link) hear it, with the claimant\'s list tag', async () => {
    people[ENTITY] = [ADMIN, COLLEAGUE, JOINER]; // JOINER's pending link is among the live links
    await request(app).post(`/entities/${ENTITY}/members`).set(as(JOINER)).send({ role: 'employee' });
    await settle();
    expect(heard()).toEqual({
      [ADMIN]: sorted([E.entity(ENTITY), E.userEntities(ADMIN), E.userEntities(JOINER)]),
      [COLLEAGUE]: sorted([E.entity(ENTITY), E.userEntities(COLLEAGUE), E.userEntities(JOINER)]),
      [JOINER]: sorted([E.entity(ENTITY), E.userEntities(JOINER)]),
    });
  });

  it.each([
    ['approve', 'post', 'approve'],
    ['decline', 'post', 'decline'],
  ] as const)('%s: the people, the admin and the member hear the entity and the member\'s list', async (_what, _method, verb) => {
    people[ENTITY] = verb === 'approve' ? [ADMIN, COLLEAGUE, JOINER] : [ADMIN, COLLEAGUE];
    expect((await request(app).post(`/entities/${ENTITY}/members/8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/${verb}`).set(as(ADMIN))).status).toBe(200);
    await settle();
    const all = heard();
    const member = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    expect(all[ADMIN]).toEqual(expect.arrayContaining([E.entity(ENTITY), E.userEntities(member)]));
    expect(all[COLLEAGUE]).toEqual(expect.arrayContaining([E.entity(ENTITY), E.userEntities(member)]));
    expect(all[member]).toEqual(sorted([E.entity(ENTITY), E.userEntities(member)]));
  });

  it('a removal: the removed member, no longer among its people, is still told', async () => {
    const member = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    people[ENTITY] = [ADMIN];
    expect((await request(app).delete(`/entities/${ENTITY}/members/${member}`).set(as(ADMIN))).status).toBe(200);
    await settle();
    expect(heard()).toEqual({
      [ADMIN]: sorted([E.entity(ENTITY), E.userEntities(ADMIN), E.userEntities(member)]),
      [member]: sorted([E.entity(ENTITY), E.userEntities(member)]),
    });
  });
});

// T15 review M2 (CLAUDE.md §1): a circle's page lists the entities linked to it with their name, kind and logo, so a
// rename, an archive or a new logo must reach the people of every linked circle too, each with only their circles.
describe('the circles an entity is linked to hear what their pages show of it (T15, review M2)', () => {
  beforeEach(() => { linkedToCircles = true; });
  const circlesHeard = () => {
    const all = heard();
    return Object.fromEntries(Object.entries(all).map(([who, tags]) => [who, tags.filter((t) => t.startsWith('circle:')).sort()]));
  };

  it.each([
    ['a rename', () => request(app).patch(`/entities/${ENTITY}`).set(as(ADMIN)).send({ name: 'Acme Boats' })],
    ['an archive', () => request(app).delete(`/entities/${ENTITY}`).set(as(ADMIN))],
    ['a new logo', () => request(app).put(`/entities/${ENTITY}/logo`).set(as(ADMIN)).send({ crop: { x: 0.5, y: 0.5, zoom: 1 } })],
    ['a removed banner', () => request(app).delete(`/entities/${ENTITY}/banner`).set(as(ADMIN))],
  ])('%s: each circle\'s people hear that circle, and nobody hears a circle they are not in', async (_what, send) => {
    expect((await send()).status).toBe(200);
    await settle();
    const tags = circlesHeard();
    expect(tags[CIRCLE_MEMBER]).toEqual([`circle:${CIRCLE_A}`, `circle:${CIRCLE_B}`].sort());
    expect(tags[OTHER_CIRCLE_PERSON]).toEqual([`circle:${CIRCLE_B}`]);
    expect(tags[ADMIN]).toEqual(expect.arrayContaining([`circle:${CIRCLE_A}`]));
    expect(tags[ADMIN]).not.toContain(`circle:${CIRCLE_B}`);
    expect(tags[COLLEAGUE] ?? []).toEqual([]);
  });

  it('a claim, an answer or a removal changes nothing a circle page shows, so no circle hears it', async () => {
    await request(app).post(`/entities/${ENTITY}/members`).set(as(JOINER)).send({ role: 'fan' });
    await request(app).post(`/entities/${ENTITY}/members/8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/approve`).set(as(ADMIN));
    await settle();
    expect(Object.values(circlesHeard()).flat()).toEqual([]);
  });
});

describe('when nobody should hear anything', () => {
  it('a refused write tells nobody', async () => {
    jest.mocked(entityService.updateEntity).mockRejectedValueOnce(new ForbiddenError("Only this entity's admins can change or archive it."));
    expect((await request(app).patch(`/entities/${ENTITY}`).set(as(COLLEAGUE)).send({ about: 'x' })).status).toBe(403);
    expect((await request(app).post(`/entities/${ENTITY}/members`).set(as(JOINER)).send({ role: 'king' })).status).toBe(400);
    await settle();
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });

  it('leaving an entity one was not linked to tells nobody', async () => {
    jest.mocked(entityService.leaveEntity).mockResolvedValueOnce({ left: false, archived: false });
    await request(app).delete(`/entities/${ENTITY}/members/me`).set(as(OUTSIDER));
    await settle();
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });

  it('a read tells nobody', async () => {
    jest.mocked(entityService.listEntities).mockResolvedValueOnce({ mine: [], others: [] });
    await request(app).get('/entities').set(as(ADMIN));
    await settle();
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });
});

describe('a fanout that fails', () => {
  it('never fails the request, and is logged', async () => {
    mockEmitEntities.mockRejectedValue(new Error('socket down'));
    const res = await request(app).delete(`/entities/${ENTITY}`).set(as(ADMIN));
    expect(res.status).toBe(200);
    await settle();
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.objectContaining({ entityId: ENTITY }), expect.stringContaining('fanoutEntityChange'));
  });
});

// The two tags are named once, on each side; ENTITIES.md is the vocabulary both read.
describe('the realtime vocabulary', () => {
  it('names an entity and a member\'s entities', () => {
    expect(E.entity(ENTITY)).toBe(`entity:${ENTITY}`);
    expect(E.userEntities(JOINER)).toBe(`user:${JOINER}:entities`);
  });

  it('ENTITIES.md lists both tags', () => {
    const md = nodeFs.readFileSync(nodePath.join(__dirname, '../../../../ENTITIES.md'), 'utf8');
    expect(md).toMatch(/\| `entity:<entityId>` \|/);
    expect(md).toMatch(/\| `user:<userId>:entities` \|/);
  });
});
