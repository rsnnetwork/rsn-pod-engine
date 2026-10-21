// ─── Entities: the service (21 Oct 2026) ─────────────────────────────────────
// Members create their company (or fund, university…) and link themselves to it with a role. Pinned
// here: one active entity per name, and a clash that says which one; the creator's empty profile
// company filled in; who may edit and archive; blocks and closed accounts on an entity's page and a
// person's list; leaving, including the last admin and the last person.
//
// The database is a stand-in that answers by what the SQL asks. Statements inside a transaction go to
// `tx`, reads outside one to `pool`, so a test can say which writes happened together. AppError
// subclasses fail `instanceof` (errors.ts sets the prototype to AppError's), so errors are matched by
// status, code, message and details.

type Rows = Array<Record<string, unknown>>;
type Result = { rows: Rows; rowCount: number };
type Answer = Rows | Error | Result;
type Rule = [RegExp, Answer];

const mockPool = jest.fn();
const mockTx = jest.fn();
const mockTransaction = jest.fn();
jest.mock('../../../db', () => ({
  query: (...a: unknown[]) => mockPool(...a),
  transaction: (cb: (client: unknown) => Promise<unknown>) => mockTransaction(cb),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockBlocked = jest.fn();
jest.mock('../../../services/block/block.service', () => ({
  areBlocked: (...a: unknown[]) => mockBlocked(...a),
  __esModule: true,
}));

import {
  archiveEntity, createEntity, entitiesOf, getEntity, leaveEntity, listEntities, listUserEntities,
  setMyMembership, updateEntity,
} from '../../../services/entity/entity.service';
import { ENTITY_ROLES, COMPANY_ROLES } from '@rsn/shared';

const ME = 'a0000000-0000-4000-8000-000000000001';
const OTHER = 'b0000000-0000-4000-8000-000000000002';
const ENTITY = 'e0000000-0000-4000-8000-00000000000e';
const OLD = 'e0000000-0000-4000-8000-0000000000aa';

/** The SQL as one line, so a pattern can span what the code wrote on several. */
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ');

/** Answers the first rule whose pattern the SQL matches; anything else finds no rows. */
function answerWith(mock: jest.Mock, rules: Rule[]) {
  mock.mockImplementation(async (sql: string) => {
    const rule = rules.find(([re]) => re.test(flat(sql)));
    if (!rule) return { rows: [], rowCount: 0 };
    const answer = rule[1];
    if (answer instanceof Error) throw answer;
    if (Array.isArray(answer)) return { rows: answer, rowCount: answer.length };
    return answer;
  });
}
const pool = (rules: Rule[]) => answerWith(mockPool, rules);
const tx = (rules: Rule[]) => answerWith(mockTx, rules);

const sqlOf = (mock: jest.Mock) => mock.mock.calls.map(c => flat(c[0]));
const callTo = (mock: jest.Mock, re: RegExp) => mock.mock.calls.find(c => re.test(flat(c[0])));
const ran = (mock: jest.Mock, re: RegExp) => sqlOf(mock).some(s => re.test(s));

const pgError = (code: string, constraint?: string) => Object.assign(new Error(`pg ${code}`), { code, constraint });
const caught = (p: Promise<unknown>) => p.then(() => null, (e: Error & Record<string, unknown>) => e);

beforeEach(() => {
  jest.clearAllMocks();
  pool([]);
  tx([]);
  mockTransaction.mockImplementation(async (cb: (client: unknown) => Promise<unknown>) => cb({ query: (...a: unknown[]) => mockTx(...a) }));
  mockBlocked.mockResolvedValue(false);
});

// The entity row a locking read returns: its name, and the viewer's admin flag when they are linked.
const LOCKED = /FROM entities e[\s\S]*FOR UPDATE/;
const SAME_NAME = /lower\(btrim\(name\)\) = lower\(btrim\(\$1\)\)/;

describe('createEntity', () => {
  const input = { name: 'Acme Ltd', kind: 'company' as const, role: 'investor' as const };

  it('makes the entity and the creator\'s link, as its admin, in one transaction', async () => {
    tx([[/INSERT INTO entities/, [{ id: ENTITY }]]]);
    const out = await createEntity(ME, { ...input, title: 'Partner', about: 'We fund boats.', location: 'Oslo', size: '11-50', website: 'https://acme.com' });
    expect(out).toEqual({ id: ENTITY, companyUpdated: false });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(callTo(mockTx, /INSERT INTO entities/)![1]).toEqual(['Acme Ltd', 'company', 'We fund boats.', 'Oslo', '11-50', 'https://acme.com', ME]);
    const link = callTo(mockTx, /INSERT INTO entity_members/)!;
    expect(String(link[0]).replace(/\s+/g, ' ')).toMatch(/VALUES \(\$1, \$2, \$3, \$4, true\)/);
    expect(link[1]).toEqual([ENTITY, ME, 'investor', 'Partner']);
    expect(mockPool).not.toHaveBeenCalled(); // every write went through the one transaction
  });

  it('stores what was not given as null', async () => {
    tx([[/INSERT INTO entities/, [{ id: ENTITY }]]]);
    await createEntity(ME, input);
    expect(callTo(mockTx, /INSERT INTO entities/)![1]).toEqual(['Acme Ltd', 'company', null, null, null, null, ME]);
    expect(callTo(mockTx, /INSERT INTO entity_members/)![1]).toEqual([ENTITY, ME, 'investor', null]);
  });

  it('stores the name trimmed, with each run of spaces inside made one, and checks that name', async () => {
    tx([[/INSERT INTO entities/, [{ id: ENTITY }]]]);
    await createEntity(ME, { ...input, name: '  Acme    Ltd ' });
    expect(callTo(mockTx, SAME_NAME)![1]).toEqual(['Acme Ltd', null]);
    expect(callTo(mockTx, /INSERT INTO entities/)![1][0]).toBe('Acme Ltd');
  });

  it('checks the name against active entities only, whatever its case and outer spaces', async () => {
    tx([[/INSERT INTO entities/, [{ id: ENTITY }]]]);
    await createEntity(ME, input);
    const check = sqlOf(mockTx).find(s => SAME_NAME.test(s))!;
    expect(check).toMatch(/archived_at IS NULL/);
    expect(sqlOf(mockTx).findIndex(s => SAME_NAME.test(s))).toBeLessThan(sqlOf(mockTx).findIndex(s => /INSERT INTO entities/.test(s)));
  });

  it('refuses a name an active entity already has, says which one, and writes nothing', async () => {
    tx([[SAME_NAME, [{ id: OLD, name: 'ACME Ltd' }]]]);
    const err = await caught(createEntity(ME, input));
    expect(err).toMatchObject({
      statusCode: 409, code: 'ENTITY_NAME_TAKEN', message: 'ACME Ltd is already on REASON.', details: { existingId: [OLD] },
    });
    expect(ran(mockTx, /INSERT/)).toBe(false);
    expect(ran(mockTx, /UPDATE users/)).toBe(false);
  });

  it('a name taken between the check and the write still answers 409 with the entity that took it', async () => {
    tx([[/INSERT INTO entities/, pgError('23505', 'idx_entities_active_name')]]);
    pool([[SAME_NAME, [{ id: OLD, name: 'Acme Ltd' }]]]);
    const err = await caught(createEntity(ME, input));
    expect(err).toMatchObject({ statusCode: 409, code: 'ENTITY_NAME_TAKEN', details: { existingId: [OLD] } });
    expect(callTo(mockPool, SAME_NAME)![1]).toEqual(['Acme Ltd', null]);
  });

  it('passes any other database failure on as it is, never as a name clash', async () => {
    const other = pgError('23505', 'entity_members_pkey');
    tx([[/INSERT INTO entity_members/, other], [/INSERT INTO entities/, [{ id: ENTITY }]]]);
    await expect(createEntity(ME, input)).rejects.toBe(other);
    const down = new Error('db down');
    tx([[/INSERT INTO entities/, down]]);
    await expect(createEntity(ME, input)).rejects.toBe(down);
    expect(ran(mockPool, SAME_NAME)).toBe(false);
  });

  it.each([['a'], ['  a  '], ['\t\n']])('refuses the name %j before it reads anything', async (name) => {
    const err = await caught(createEntity(ME, { ...input, name }));
    expect(err).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  describe('the creator\'s profile company', () => {
    it.each([...COMPANY_ROLES])('is filled with the entity\'s name when it is empty and they are its %s', async (role) => {
      tx([[/INSERT INTO entities/, [{ id: ENTITY }]], [/UPDATE users/, { rows: [], rowCount: 1 }]]);
      const out = await createEntity(ME, { ...input, name: ' Acme   Ltd', role });
      expect(out.companyUpdated).toBe(true);
      const fill = callTo(mockTx, /UPDATE users/)!;
      expect(String(fill[0]).replace(/\s+/g, ' ')).toMatch(/SET company = \$2 WHERE id = \$1 AND \(company IS NULL OR company ~ '\^\[\[:space:\]\]\*\$'\)/);
      expect(fill[1]).toEqual([ME, 'Acme Ltd']);
    });

    it('is never overwritten when they already have one', async () => {
      tx([[/INSERT INTO entities/, [{ id: ENTITY }]], [/UPDATE users/, { rows: [], rowCount: 0 }]]);
      expect((await createEntity(ME, { ...input, role: 'founder' })).companyUpdated).toBe(false);
    });

    it.each(ENTITY_ROLES.filter(r => !COMPANY_ROLES.includes(r)))('is left alone when they are its %s', async (role) => {
      tx([[/INSERT INTO entities/, [{ id: ENTITY }]], [/UPDATE users/, { rows: [], rowCount: 1 }]]);
      expect((await createEntity(ME, { ...input, role })).companyUpdated).toBe(false);
      expect(ran(mockTx, /UPDATE users/)).toBe(false);
    });
  });
});

describe('listEntities', () => {
  const MINE = /FROM entity_members m JOIN entities e/;
  const OTHERS = /FROM entities e WHERE/;
  const row = (id: string, name: string, myRole: string | null) => ({ id, name, kind: 'company', location: 'Oslo', my_role: myRole, people_count: 3 });

  it('gives the viewer\'s own entities with their role, and others they are not linked to', async () => {
    pool([[MINE, [row(ENTITY, 'Acme Ltd', 'founder')]], [OTHERS, [row(OLD, 'Beta Fund', null)]]]);
    expect(await listEntities(ME)).toEqual({
      mine: [{ id: ENTITY, name: 'Acme Ltd', kind: 'company', location: 'Oslo', peopleCount: 3, myRole: 'founder' }],
      others: [{ id: OLD, name: 'Beta Fund', kind: 'company', location: 'Oslo', peopleCount: 3, myRole: null }],
    });
    expect(callTo(mockPool, MINE)![1]).toEqual([ME]);
  });

  it('lists the viewer\'s own active entities by name', async () => {
    await listEntities(ME);
    const mine = sqlOf(mockPool).find(s => MINE.test(s))!;
    expect(mine).toMatch(/m\.user_id = \$1 AND e\.archived_at IS NULL/);
    expect(mine).toMatch(/ORDER BY lower\(e\.name\)/);
    expect(mine).toMatch(/LIMIT 100/);
  });

  it('with no search, others are the most recently active, 30 at most, never archived and never the viewer\'s own', async () => {
    await listEntities(ME);
    const others = sqlOf(mockPool).find(s => OTHERS.test(s))!;
    expect(others).toMatch(/e\.archived_at IS NULL/);
    expect(others).toMatch(/NOT EXISTS \(SELECT 1 FROM entity_members m WHERE m\.entity_id = e\.id AND m\.user_id = \$1\)/);
    expect(others).toMatch(/ORDER BY e\.updated_at DESC/);
    expect(others).not.toMatch(/ILIKE/);
    expect(callTo(mockPool, OTHERS)![1]).toEqual([ME, 30]);
  });

  it.each([[''], ['a'], ['  b  ']])('a search of %j (under 2 characters) lists the recent ones instead', async (q) => {
    await listEntities(ME, { q });
    expect(sqlOf(mockPool).find(s => OTHERS.test(s))).not.toMatch(/ILIKE/);
  });

  it('searches names from 2 characters on, the whole name first, then names that start with it', async () => {
    await listEntities(ME, { q: '  ac  ', limit: 10 });
    const others = sqlOf(mockPool).find(s => OTHERS.test(s))!;
    expect(others).toMatch(/e\.name ILIKE \$2/);
    expect(others).toMatch(/NOT EXISTS \(SELECT 1 FROM entity_members m WHERE m\.entity_id = e\.id AND m\.user_id = \$1\)/);
    expect(others).toMatch(/ORDER BY \(lower\(btrim\(e\.name\)\) = lower\(\$3\)\) DESC, \(e\.name ILIKE \$4\) DESC/);
    expect(callTo(mockPool, OTHERS)![1]).toEqual([ME, '%ac%', 'ac', 'ac%', 10]);
  });

  it('reads %, _ and \\ in a search as the characters typed, not as wildcards', async () => {
    await listEntities(ME, { q: '50%_off\\' });
    expect(callTo(mockPool, OTHERS)![1]).toEqual([ME, '%50\\%\\_off\\\\%', '50%_off\\', '50\\%\\_off\\\\%', 30]);
  });

  it.each([[100, 30], [0, 1], [-5, 1], [7.9, 7]])('holds a limit of %p to %p', async (limit, held) => {
    await listEntities(ME, { limit });
    expect(callTo(mockPool, OTHERS)![1]).toEqual([ME, held]);
  });

  it('counts, on every card, only the people the viewer can see: active, and not blocked either way', async () => {
    await listEntities(ME, { q: 'acme' });
    for (const sql of [sqlOf(mockPool).find(s => MINE.test(s))!, sqlOf(mockPool).find(s => OTHERS.test(s))!]) {
      expect(sql).toMatch(/pu\.status = 'active'/);
      expect(sql).toMatch(/b\.blocker_id = \$1 AND b\.blocked_id = pm\.user_id\) OR \(b\.blocker_id = pm\.user_id AND b\.blocked_id = \$1/);
    }
  });
});

describe('getEntity', () => {
  const ENTITY_ROW = /FROM entities e LEFT JOIN entity_members my/;
  const PEOPLE = /FROM entity_members m JOIN users u/;
  const created = new Date('2026-10-21T09:00:00Z');
  const updated = new Date('2026-10-21T10:30:00Z');
  const entityRow = (my: { role: string | null; admin: boolean | null }) => ({
    id: ENTITY, name: 'Acme Ltd', kind: 'company', about: 'We build boats.', location: 'Oslo', size: '11-50',
    website: 'https://acme.com', created_at: created, updated_at: updated, my_role: my.role, my_admin: my.admin, people_count: 2,
  });
  const person = {
    id: OTHER, displayName: 'Sarah Chen', firstName: 'Sarah', lastName: 'Chen', avatarUrl: null, jobTitle: 'CEO',
    company: 'Acme Ltd', location: 'Oslo', entityRole: 'founder', entityTitle: 'Chief Executive', entityAdmin: true,
    // A row never carries these (the SQL does not select them); if one ever did, it must not reach the page.
    email: 'sarah@example.com', whoIWantToMeet: 'SECRET-WANT',
  };

  it('answers 404 for a missing or archived entity, in words a member can read', async () => {
    const err = await caught(getEntity(ME, ENTITY, false));
    expect(err).toMatchObject({ statusCode: 404, code: 'ENTITY_NOT_FOUND', message: 'This entity could not be found.' });
    expect(sqlOf(mockPool)[0]).toMatch(/e\.id = \$1 AND e\.archived_at IS NULL/);
    expect(ran(mockPool, PEOPLE)).toBe(false);
  });

  it('gives the entity, its people with their role and title, and the viewer\'s own role', async () => {
    pool([[ENTITY_ROW, [entityRow({ role: 'employee', admin: false })]], [PEOPLE, [person]]]);
    expect(await getEntity(ME, ENTITY, false)).toEqual({
      entity: {
        id: ENTITY, name: 'Acme Ltd', kind: 'company', about: 'We build boats.', location: 'Oslo', size: '11-50',
        website: 'https://acme.com', peopleCount: 2, createdAt: '2026-10-21T09:00:00.000Z', updatedAt: '2026-10-21T10:30:00.000Z',
      },
      people: [{
        id: OTHER, displayName: 'Sarah Chen', firstName: 'Sarah', lastName: 'Chen', avatarUrl: null, jobTitle: 'CEO',
        company: 'Acme Ltd', location: 'Oslo', role: 'founder', title: 'Chief Executive', isAdmin: true,
      }],
      myRole: 'employee',
      canEdit: false,
    });
    expect(callTo(mockPool, ENTITY_ROW)![1]).toEqual([ENTITY, ME]);
    expect(callTo(mockPool, PEOPLE)![1]).toEqual([ENTITY, ME]);
  });

  it('lists active people only, and nobody the viewer has blocked or who has blocked the viewer', async () => {
    pool([[ENTITY_ROW, [entityRow({ role: null, admin: null })]]]);
    await getEntity(ME, ENTITY, false);
    const people = sqlOf(mockPool).find(s => PEOPLE.test(s))!;
    expect(people).toMatch(/u\.status = 'active'/);
    expect(people).toMatch(/\(b\.blocker_id = \$2 AND b\.blocked_id = m\.user_id\) OR \(b\.blocker_id = m\.user_id AND b\.blocked_id = \$2\)/);
    expect(people).toMatch(/ORDER BY m\.is_admin DESC, m\.created_at ASC/);
    expect(people).toMatch(/LIMIT 200/);
    // the count on the page counts the same people
    expect(sqlOf(mockPool).find(s => ENTITY_ROW.test(s))).toMatch(/pu\.status = 'active'[\s\S]*user_blocks/);
  });

  it('selects only the public card basics of each person', async () => {
    pool([[ENTITY_ROW, [entityRow({ role: null, admin: null })]], [PEOPLE, [person]]]);
    const page = await getEntity(ME, ENTITY, false);
    expect(JSON.stringify(page)).not.toMatch(/sarah@example\.com|SECRET/);
    const people = sqlOf(mockPool).find(s => PEOPLE.test(s))!;
    expect(people).not.toMatch(/email|who_i_want|why_i_want|my_intent|interests|phone/);
  });

  it.each([
    ['one of its admins', { role: 'founder', admin: true }, false, true],
    ['a member who is not an admin', { role: 'employee', admin: false }, false, false],
    ['someone not linked to it', { role: null, admin: null }, false, false],
    ['a platform admin not linked to it', { role: null, admin: null }, true, true],
  ] as const)('lets %s edit it: %#', async (_who, my, platformAdmin, canEdit) => {
    pool([[ENTITY_ROW, [entityRow(my)]]]);
    const page = await getEntity(ME, ENTITY, platformAdmin);
    expect(page.canEdit).toBe(canEdit);
    expect(page.myRole).toBe(my.role);
  });
});

describe('updateEntity', () => {
  const admin = (isAdmin: boolean | null) => [[LOCKED, [{ name: 'Acme Ltd', is_admin: isAdmin }]]] as Rule[];

  it('answers 404 for a missing or archived entity, and writes nothing', async () => {
    const err = await caught(updateEntity(ME, ENTITY, { about: 'x' }, true));
    expect(err).toMatchObject({ statusCode: 404, code: 'ENTITY_NOT_FOUND' });
    expect(sqlOf(mockTx)[0]).toMatch(/e\.id = \$1 AND e\.archived_at IS NULL FOR UPDATE OF e/);
    expect(ran(mockTx, /UPDATE entities/)).toBe(false);
  });

  it.each([[false], [null]])('refuses a member who is not one of its admins (is_admin %p), and writes nothing', async (isAdmin) => {
    tx(admin(isAdmin));
    const err = await caught(updateEntity(ME, ENTITY, { about: 'x' }, false));
    expect(err).toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN', message: "Only this entity's admins can change or archive it." });
    expect(ran(mockTx, /UPDATE entities/)).toBe(false);
  });

  it('lets a platform admin edit an entity they are not linked to', async () => {
    tx(admin(null));
    await updateEntity(ME, ENTITY, { about: 'Edited by an admin.' }, true);
    expect(ran(mockTx, /UPDATE entities SET about = \$2, updated_at = NOW\(\) WHERE id = \$1/)).toBe(true);
  });

  it('writes only the fields given, clears one given as null, and marks the entity active', async () => {
    tx(admin(true));
    await updateEntity(ME, ENTITY, { kind: 'startup', location: null, website: 'https://acme.io' }, false);
    const write = callTo(mockTx, /UPDATE entities/)!;
    expect(String(write[0]).replace(/\s+/g, ' ')).toBe('UPDATE entities SET kind = $2, location = $3, website = $4, updated_at = NOW() WHERE id = $1');
    expect(write[1]).toEqual([ENTITY, 'startup', null, 'https://acme.io']);
    expect(ran(mockTx, SAME_NAME)).toBe(false); // no new name, nothing to check
  });

  it('renames to the normalised name once no other active entity has it', async () => {
    tx(admin(true));
    await updateEntity(ME, ENTITY, { name: ' Acme   Group ' }, false);
    expect(callTo(mockTx, SAME_NAME)![1]).toEqual(['Acme Group', ENTITY]);
    expect(sqlOf(mockTx).find(s => SAME_NAME.test(s))).toMatch(/id <> \$2::uuid/);
    expect(callTo(mockTx, /UPDATE entities/)![1]).toEqual([ENTITY, 'Acme Group']);
  });

  it('refuses a name another active entity has, says which one, and writes nothing', async () => {
    tx([...admin(true), [SAME_NAME, [{ id: OLD, name: 'Acme Group' }]]]);
    const err = await caught(updateEntity(ME, ENTITY, { name: 'acme group' }, false));
    expect(err).toMatchObject({ statusCode: 409, code: 'ENTITY_NAME_TAKEN', details: { existingId: [OLD] } });
    expect(ran(mockTx, /UPDATE entities/)).toBe(false);
  });

  it('a name taken between the check and the write still answers 409 with the entity that took it', async () => {
    tx([...admin(true), [/UPDATE entities/, pgError('23505', 'idx_entities_active_name')]]);
    pool([[SAME_NAME, [{ id: OLD, name: 'Acme Group' }]]]);
    const err = await caught(updateEntity(ME, ENTITY, { name: 'Acme Group' }, false));
    expect(err).toMatchObject({ statusCode: 409, details: { existingId: [OLD] } });
    expect(callTo(mockPool, SAME_NAME)![1]).toEqual(['Acme Group', ENTITY]);
  });
});

describe('setMyMembership (join, or change your own role)', () => {
  const LINK = /SELECT title, is_admin FROM entity_members/;
  const open = [[LOCKED, [{ name: 'Acme Ltd', is_admin: null }]]] as Rule[];

  it('answers 404 for a missing or archived entity, and writes nothing', async () => {
    const err = await caught(setMyMembership(ME, ENTITY, { role: 'employee' }));
    expect(err).toMatchObject({ statusCode: 404, code: 'ENTITY_NOT_FOUND' });
    expect(ran(mockTx, /INSERT INTO|UPDATE \w+ SET/)).toBe(false); // the lock's FOR UPDATE writes nothing
  });

  it('takes the entity\'s lock before it reads the link', async () => {
    tx(open);
    await setMyMembership(ME, ENTITY, { role: 'employee' });
    expect(sqlOf(mockTx)[0]).toMatch(/FOR UPDATE OF e/);
  });

  it('joins as the role given, not as an admin, and marks the entity active', async () => {
    tx(open);
    const out = await setMyMembership(ME, ENTITY, { role: 'advisor', title: 'Board advisor' });
    expect(out).toEqual({ joined: true, role: 'advisor', title: 'Board advisor', isAdmin: false, companyUpdated: false });
    const join = callTo(mockTx, /INSERT INTO entity_members/)!;
    expect(String(join[0])).not.toMatch(/is_admin/);
    expect(join[1]).toEqual([ENTITY, ME, 'advisor', 'Board advisor']);
    expect(ran(mockTx, /UPDATE entities SET updated_at = NOW\(\) WHERE id = \$1/)).toBe(true);
  });

  it('changes the role of an existing link, keeps its title when none is given, and keeps its admin', async () => {
    tx([...open, [LINK, [{ title: 'CEO', is_admin: true }]]]);
    const out = await setMyMembership(ME, ENTITY, { role: 'former_employee' });
    expect(out).toEqual({ joined: false, role: 'former_employee', title: 'CEO', isAdmin: true, companyUpdated: false });
    expect(callTo(mockTx, /UPDATE entity_members SET role/)![1]).toEqual([ENTITY, ME, 'former_employee', 'CEO']);
    expect(ran(mockTx, /INSERT INTO entity_members/)).toBe(false);
  });

  it('clears the title when it is given as null', async () => {
    tx([...open, [LINK, [{ title: 'CEO', is_admin: false }]]]);
    const out = await setMyMembership(ME, ENTITY, { role: 'employee', title: null });
    expect(out.title).toBeNull();
    expect(callTo(mockTx, /UPDATE entity_members SET role/)![1]).toEqual([ENTITY, ME, 'employee', null]);
  });

  it.each([...COMPANY_ROLES])('fills an empty profile company with the entity\'s name on joining as its %s', async (role) => {
    tx([...open, [/UPDATE users/, { rows: [], rowCount: 1 }]]);
    const out = await setMyMembership(ME, ENTITY, { role });
    expect(out.companyUpdated).toBe(true);
    expect(callTo(mockTx, /UPDATE users/)![1]).toEqual([ME, 'Acme Ltd']);
  });

  it('leaves the profile company alone when joining as an investor', async () => {
    tx([...open, [/UPDATE users/, { rows: [], rowCount: 1 }]]);
    expect((await setMyMembership(ME, ENTITY, { role: 'investor' })).companyUpdated).toBe(false);
    expect(ran(mockTx, /UPDATE users/)).toBe(false);
  });
});

describe('leaveEntity', () => {
  const open = [[LOCKED, [{ name: 'Acme Ltd', is_admin: null }]]] as Rule[];
  const LEFT = /DELETE FROM entity_members/;
  const REST = /count\(\*\) FILTER/;
  const PROMOTE = /UPDATE entity_members SET is_admin = true/;
  const ARCHIVE = /UPDATE entities SET archived_at = NOW\(\)/;

  it('answers 404 for a missing or archived entity, and removes nothing', async () => {
    const err = await caught(leaveEntity(ME, ENTITY));
    expect(err).toMatchObject({ statusCode: 404, code: 'ENTITY_NOT_FOUND' });
    expect(ran(mockTx, LEFT)).toBe(false);
  });

  it('is a no-op for someone not linked to it', async () => {
    tx(open);
    expect(await leaveEntity(ME, ENTITY)).toEqual({ left: false, archived: false });
    expect(ran(mockTx, ARCHIVE)).toBe(false);
    expect(ran(mockTx, /UPDATE entities/)).toBe(false);
  });

  it('removes only the member\'s own link, and marks the entity active', async () => {
    tx([...open, [LEFT, [{ is_admin: false }]], [REST, [{ people: 3, active_admins: 1 }]]]);
    expect(await leaveEntity(ME, ENTITY)).toEqual({ left: true, archived: false });
    expect(callTo(mockTx, LEFT)![1]).toEqual([ENTITY, ME]);
    expect(ran(mockTx, PROMOTE)).toBe(false);
    expect(ran(mockTx, /UPDATE entities SET updated_at = NOW\(\) WHERE id = \$1/)).toBe(true);
  });

  it('archives the entity when the last person leaves it, and deletes nothing else', async () => {
    tx([...open, [LEFT, [{ is_admin: true }]], [REST, [{ people: 0, active_admins: 0 }]]]);
    expect(await leaveEntity(ME, ENTITY)).toEqual({ left: true, archived: true });
    expect(callTo(mockTx, ARCHIVE)![1]).toEqual([ENTITY]);
    expect(ran(mockTx, /DELETE FROM entities/)).toBe(false);
    expect(ran(mockTx, PROMOTE)).toBe(false);
  });

  it('when the last active admin leaves, the longest-standing active person becomes an admin', async () => {
    tx([...open, [LEFT, [{ is_admin: true }]], [REST, [{ people: 2, active_admins: 0 }]]]);
    expect(await leaveEntity(ME, ENTITY)).toEqual({ left: true, archived: false });
    const promote = sqlOf(mockTx).find(s => PROMOTE.test(s))!;
    expect(promote).toMatch(/u\.status = 'active'/);
    expect(promote).toMatch(/ORDER BY m\.created_at ASC, m\.user_id ASC LIMIT 1/);
    expect(callTo(mockTx, PROMOTE)![1]).toEqual([ENTITY]);
    expect(sqlOf(mockTx).find(s => REST.test(s))).toMatch(/m\.is_admin AND u\.status = 'active'/);
  });

  it('an admin leaving while another active admin stays promotes nobody', async () => {
    tx([...open, [LEFT, [{ is_admin: true }]], [REST, [{ people: 2, active_admins: 1 }]]]);
    await leaveEntity(ME, ENTITY);
    expect(ran(mockTx, PROMOTE)).toBe(false);
  });

  it('someone who is not an admin leaving promotes nobody, whatever the admins are', async () => {
    tx([...open, [LEFT, [{ is_admin: false }]], [REST, [{ people: 2, active_admins: 0 }]]]);
    await leaveEntity(ME, ENTITY);
    expect(ran(mockTx, PROMOTE)).toBe(false);
  });
});

describe('archiveEntity', () => {
  const ARCHIVE = /UPDATE entities SET archived_at = NOW\(\), updated_at = NOW\(\) WHERE id = \$1/;

  it('answers 404 for a missing or already archived entity', async () => {
    const err = await caught(archiveEntity(ME, ENTITY, true));
    expect(err).toMatchObject({ statusCode: 404, code: 'ENTITY_NOT_FOUND' });
    expect(ran(mockTx, ARCHIVE)).toBe(false);
  });

  it.each([[false], [null]])('refuses someone who is not one of its admins (is_admin %p)', async (isAdmin) => {
    tx([[LOCKED, [{ name: 'Acme Ltd', is_admin: isAdmin }]]]);
    const err = await caught(archiveEntity(ME, ENTITY, false));
    expect(err).toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
    expect(ran(mockTx, ARCHIVE)).toBe(false);
  });

  it.each([
    ['one of its admins', true, false],
    ['a platform admin not linked to it', null, true],
  ] as const)('lets %s archive it, keeping every link: %#', async (_who, isAdmin, platformAdmin) => {
    tx([[LOCKED, [{ name: 'Acme Ltd', is_admin: isAdmin }]]]);
    await archiveEntity(ME, ENTITY, platformAdmin);
    expect(callTo(mockTx, ARCHIVE)![1]).toEqual([ENTITY]);
    expect(ran(mockTx, /DELETE/)).toBe(false);
  });
});

describe('a person\'s entities', () => {
  const STATUS = /SELECT status FROM users WHERE id = \$1/;
  const THEIRS = /FROM entity_members m JOIN entities e ON e\.id = m\.entity_id/;
  const theirs = [{ id: ENTITY, name: 'Acme Ltd', kind: 'company', role: 'founder', title: 'CEO' }];

  it('lists id, name, kind, role and title, active entities only, by name', async () => {
    pool([[STATUS, [{ status: 'active' }]], [THEIRS, theirs]]);
    expect(await listUserEntities(ME, OTHER)).toEqual(theirs);
    const sql = sqlOf(mockPool).find(s => THEIRS.test(s))!;
    expect(sql).toMatch(/m\.user_id = \$1 AND e\.archived_at IS NULL/);
    expect(sql).toMatch(/ORDER BY lower\(e\.name\)/);
    expect(callTo(mockPool, THEIRS)![1]).toEqual([OTHER]);
    expect(mockBlocked).toHaveBeenCalledWith(ME, OTHER);
  });

  it('answers blocked (either way), closed and unknown in exactly the same words, and reads nothing else', async () => {
    mockBlocked.mockResolvedValueOnce(true);
    const blocked = await caught(listUserEntities(ME, OTHER));
    pool([[STATUS, [{ status: 'deactivated' }]]]);
    const closed = await caught(listUserEntities(ME, OTHER));
    pool([[STATUS, []]]);
    const unknown = await caught(listUserEntities(ME, OTHER));
    expect(blocked).toMatchObject({ statusCode: 404, code: 'USER_NOT_FOUND', message: 'This person is not available.' });
    for (const e of [closed, unknown]) {
      expect({ s: e?.statusCode, c: e?.code, m: e?.message }).toEqual({ s: blocked?.statusCode, c: blocked?.code, m: blocked?.message });
    }
    expect(ran(mockPool, THEIRS)).toBe(false);
  });

  it('gives a member their own list without asking about blocks or status', async () => {
    pool([[THEIRS, theirs]]);
    expect(await listUserEntities(ME, ME)).toEqual(theirs);
    expect(mockBlocked).not.toHaveBeenCalled();
    expect(ran(mockPool, STATUS)).toBe(false);
  });

  it('entitiesOf reads the one person\'s links only', async () => {
    pool([[THEIRS, theirs]]);
    expect(await entitiesOf(OTHER)).toEqual(theirs);
    expect(mockPool).toHaveBeenCalledTimes(1);
    expect(callTo(mockPool, THEIRS)![1]).toEqual([OTHER]);
  });
});
