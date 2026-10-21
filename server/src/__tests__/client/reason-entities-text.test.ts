// server/src/__tests__/client/reason-entities-text.test.ts
// What the Entities pages say, the rules behind their forms, and the addresses they ask for, EXECUTED.
// entity-text.ts and entity-form.ts have no React, axios, store or router behind them, so a test can import
// them; entity-api.ts imports the HTTP client, so it is transpiled and run with a recording stand-in instead
// (as reason-m1-profile.test.ts does for api.ts). The markup and wiring are pinned in reason-entities-pages.test.ts.
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';
import type { FieldValues, Resolver } from 'react-hook-form';
import { ENTITY_KINDS, ENTITY_KIND_LABELS, ENTITY_LIMITS, ENTITY_ROLES, ENTITY_ROLE_LABELS } from '@rsn/shared';
import { CONNECTION_LOST } from '../../../../client/src/features/reason/errors';
import {
  ENTITY_GONE, SIZE_OPTIONS, createdToast, entitiesOf, entityError, entityLetter, entityMeta, fieldErrors, isEntityId,
  joinedToast, kindLabel, leftToast, loadFailedLine, nameTakenId, peopleCount, roleLabel, roleLine, searchTerm, sizeChoices,
  sizeText, tidyName, websiteLink,
} from '../../../../client/src/features/reason/entities/entity-text';
import {
  createBody, createDefaults, createSchema, editChanges, editDefaults, editSchema, formResolver, roleBody, roleDefaults, roleSchema,
} from '../../../../client/src/features/reason/entities/entity-form';

const ID = '3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03';
// What axios hands a catch block when the server answered, and when nothing did.
const answered = (status: number, error: Record<string, unknown> = {}) => ({ isAxiosError: true, response: { status, data: { success: false, error } } });
const noAnswer = Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' });
const taken = (existingId: unknown) => answered(409, { code: 'ENTITY_NAME_TAKEN', message: 'Acme Ltd is already on REASON.', details: { existingId } });

describe('labels: the Foundation\'s own words, and a word for anything newer than this build', () => {
  it('names every kind and every role from the shared lists', () => {
    for (const k of ENTITY_KINDS) expect(kindLabel(k)).toBe(ENTITY_KIND_LABELS[k]);
    for (const r of ENTITY_ROLES) expect(roleLabel(r)).toBe(ENTITY_ROLE_LABELS[r]);
  });
  it('a kind or role the server added after this build is still words, never "undefined"', () => {
    expect(kindLabel('guild')).toBe('Organisation');
    expect(roleLabel('mentor')).toBe('Other');
  });
});

describe('a card\'s small lines', () => {
  it('counts people in words', () => {
    expect(peopleCount(0)).toBe('0 people');
    expect(peopleCount(1)).toBe('1 person');
    expect(peopleCount(2)).toBe('2 people');
    expect(peopleCount(1234)).toBe('1234 people');
  });
  it('says the kind, then the place when there is one', () => {
    expect(entityMeta({ kind: 'company', location: 'Copenhagen' })).toBe('Company · Copenhagen');
    expect(entityMeta({ kind: 'investment_vehicle', location: null })).toBe('Investment vehicle');
    expect(entityMeta({ kind: 'fund', location: '   ' })).toBe('Fund');
  });
  it('says the role, then the title when there is one', () => {
    expect(roleLine('founder', 'CEO')).toBe('Founder · CEO');
    expect(roleLine('board_member', null)).toBe('Board member');
    expect(roleLine('advisor', '  ')).toBe('Advisor');
    expect(roleLine('employee', undefined)).toBe('Employee');
  });
  it('draws the first character a reader sees, upper case', () => {
    expect(entityLetter('acme Ltd')).toBe('A');
    expect(entityLetter('  zeta')).toBe('Z');
    expect(entityLetter('Ørsted')).toBe('Ø');
  });
});

describe('size', () => {
  it('offers exactly the five sizes the brief lists', () => {
    expect([...SIZE_OPTIONS]).toEqual(['1-10', '11-50', '51-200', '201-1000', '1000+']);
  });
  it('a chosen size reads as people; a size typed elsewhere is shown as it was written', () => {
    expect(sizeText('11-50')).toBe('11-50 people');
    expect(sizeText('1000+')).toBe('1000+ people');
    expect(sizeText('Seed stage')).toBe('Seed stage');
    expect(sizeText(null)).toBeNull();
    expect(sizeText('  ')).toBeNull();
  });
  it('the edit form keeps a size that is not one of the five, so saving never loses it', () => {
    expect(sizeChoices(null)).toEqual([...SIZE_OPTIONS]);
    expect(sizeChoices('51-200')).toEqual([...SIZE_OPTIONS]);
    expect(sizeChoices('Seed stage')).toEqual(['Seed stage', ...SIZE_OPTIONS]);
  });
});

describe('the website is only ever an http or https link', () => {
  it('shows the address without its scheme or a closing slash', () => {
    expect(websiteLink('https://acme.com')).toEqual({ href: 'https://acme.com/', text: 'acme.com' });
    expect(websiteLink('http://www.acme.com/about/')).toEqual({ href: 'http://www.acme.com/about/', text: 'www.acme.com/about' });
  });
  it('draws no link for anything else, however it got there', () => {
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,hi', 'mailto:a@b.co', 'ftp://acme.com', 'acme.com', 'not a url', '', null, undefined]) {
      expect(websiteLink(bad)).toBeNull();
    }
  });
});

describe('ids, names and the search box', () => {
  it('knows an entity id in either case, and nothing else', () => {
    expect(isEntityId(ID)).toBe(true);
    expect(isEntityId(ID.toUpperCase())).toBe(true);
    for (const s of ['', 'acme', `${ID}x`, ` ${ID}`, '../entities?q=a', ID.replace(/-/g, '')]) expect(isEntityId(s)).toBe(false);
  });
  it('tidies a name the way the server stores it: outer spaces off, inner runs of spaces made one', () => {
    expect(tidyName('  Acme   Ltd  ')).toBe('Acme Ltd');
    expect(tidyName('Acme\tLtd')).toBe('Acme Ltd');
  });
  it('asks the server to search only from 2 characters, as the server does: one character is the recent list, not "nothing found"', () => {
    expect(searchTerm('')).toBe('');
    expect(searchTerm('a')).toBe('');
    expect(searchTerm(' a ')).toBe('');
    expect(searchTerm('ac')).toBe('ac');
    expect(searchTerm('  acme   ltd ')).toBe('acme ltd');
    expect(searchTerm('x'.repeat(ENTITY_LIMITS.searchMax + 20))).toHaveLength(ENTITY_LIMITS.searchMax);
  });
});

describe('a person\'s entities, read from the brief', () => {
  it('is the brief\'s list, or none when the API answering has no such field yet (the live API before Task 10 ships)', () => {
    const list = [{ id: ID, name: 'Acme', kind: 'company' as const, role: 'founder' as const, title: null }];
    expect(entitiesOf({ entities: list })).toBe(list);
    expect(entitiesOf({})).toEqual([]);
    expect(entitiesOf({ entities: null })).toEqual([]);
  });
});

describe('what a failed request says', () => {
  it('a 404 is the entity being gone, never "this person"', () => {
    expect(entityError(answered(404, { code: 'ENTITY_NOT_FOUND', message: 'This entity could not be found.' }), 'x')).toBe(ENTITY_GONE);
    expect(ENTITY_GONE).not.toMatch(/person/i);
  });
  it('a 404 that is not about an entity (an API without the entities routes yet, such as the live one before they ship) is the fallback, not "gone"', () => {
    expect(entityError(answered(404, { code: 'NOT_FOUND', message: 'Route not found' }), 'Could not create it just now.')).toBe('Could not create it just now.');
    expect(entityError(answered(404), 'Could not create it just now.')).toBe('Could not create it just now.');
  });
  it('a 429 passes on the server\'s own sentence (the hourly create limit has its own), and slows down otherwise', () => {
    expect(entityError(answered(429, { code: 'RATE_LIMITED', message: 'You have added a lot of entities this hour. Try again later.' }), 'x'))
      .toBe('You have added a lot of entities this hour. Try again later.');
    expect(entityError(answered(429, {}), 'x')).toBe('Slow down a moment, then try again.');
    expect(entityError(answered(429, { message: `Limit for ${ID}` }), 'x')).toBe('Slow down a moment, then try again.');
  });
  it('a 403 gives the refusal written for members; a lost connection says so; anything else the fallback', () => {
    expect(entityError(answered(403, { code: 'AUTH_FORBIDDEN', message: "Only this entity's admins can change or archive it." }), 'x'))
      .toBe("Only this entity's admins can change or archive it.");
    expect(entityError(noAnswer, 'x')).toBe(CONNECTION_LOST);
    expect(entityError(answered(500, { message: 'boom' }), 'Could not save that.')).toBe('Could not save that.');
  });
  it('a list or a page that could not load says why only when it knows: the connection, or slow down', () => {
    expect(loadFailedLine(undefined, 'paused')).toBe(CONNECTION_LOST);
    expect(loadFailedLine(noAnswer, 'idle')).toBe(CONNECTION_LOST);
    expect(loadFailedLine(answered(429), 'idle')).toBe('Slow down a moment, then try again.');
    // A 404 from an API that has no /entities yet is not "this person" and not "this entity".
    expect(loadFailedLine(answered(404), 'idle')).toBe('Try again in a moment.');
    expect(loadFailedLine(answered(500), 'idle')).toBe('Try again in a moment.');
  });
});

describe('the name is taken (409)', () => {
  it('gives the id of the entity that has the name, in lower case', () => {
    expect(nameTakenId(taken([ID]))).toBe(ID);
    expect(nameTakenId(taken([ID.toUpperCase()]))).toBe(ID);
  });
  it('is nothing for any other answer, or a 409 without a usable id', () => {
    expect(nameTakenId(answered(409, { code: 'CONFLICT', details: { existingId: [ID] } }))).toBeNull();
    expect(nameTakenId(answered(400, { code: 'ENTITY_NAME_TAKEN', details: { existingId: [ID] } }))).toBeNull();
    for (const existingId of [[], ['../entities'], 'x', [42], undefined]) expect(nameTakenId(taken(existingId))).toBeNull();
    expect(nameTakenId(noAnswer)).toBeNull();
    expect(nameTakenId(null)).toBeNull();
  });
});

describe('a refused form puts each reason next to its own field', () => {
  it('maps the server\'s details to the fields it names, first line each', () => {
    const err = answered(400, {
      code: 'VALIDATION_ERROR', message: 'Validation failed',
      details: { name: ['Give the entity a name of at least 2 characters.'], website: ['Enter a web address, such as acme.com.', 'second'], _root: ['Nothing to change.'] },
    });
    expect(fieldErrors(err)).toEqual({ name: 'Give the entity a name of at least 2 characters.', website: 'Enter a web address, such as acme.com.' });
  });
  it('is empty for anything that is not a 400 with details, and never passes on an id', () => {
    expect(fieldErrors(answered(409, { details: { name: ['x'] } }))).toEqual({});
    expect(fieldErrors(answered(400, { message: 'Bad' }))).toEqual({});
    expect(fieldErrors(answered(400, { details: { name: [`Entity ${ID} is odd`] } }))).toEqual({});
    expect(fieldErrors(noAnswer)).toEqual({});
  });
});

describe('the toasts', () => {
  it('say what happened, and when the profile company was filled in, that too', () => {
    expect(createdToast('Acme', false)).toBe('Acme is on REASON.');
    expect(createdToast('Acme', true)).toBe('Acme is on REASON. Your profile now shows it as your company.');
    expect(joinedToast('Acme', false)).toBe('You joined Acme.');
    expect(joinedToast('Acme', true)).toBe('You joined Acme. Your profile now shows it as your company.');
    expect(leftToast('Acme', false)).toBe('You left Acme.');
    expect(leftToast('Acme', true)).toBe('You left Acme. No one else was linked to it, so it is archived.');
  });
});

describe('the create and edit forms', () => {
  const resolveCreate = formResolver(createSchema);
  const resolveEdit = formResolver(editSchema);
  const run = async <T extends FieldValues>(resolver: Resolver<T>, values: unknown) =>
    resolver(values as T, undefined, { fields: {}, shouldUseNativeValidation: false });

  it('start as the brief says: a company, and you as its founder', () => {
    expect(createDefaults()).toEqual({ name: '', kind: 'company', role: 'founder', title: '', location: '', size: '', about: '', website: '' });
    expect(createDefaults('Acme').name).toBe('Acme');
  });
  it('a name needs 2 characters once tidied, with the server\'s own words', async () => {
    const empty = await run(resolveCreate, createDefaults('   '));
    expect(empty.errors).toMatchObject({ name: { message: 'Give the entity a name.' } });
    const one = await run(resolveCreate, createDefaults('A '));
    expect(one.errors).toMatchObject({ name: { message: 'Give the entity a name of at least 2 characters.' } });
    const long = await run(resolveCreate, createDefaults('x'.repeat(ENTITY_LIMITS.nameMax + 1)));
    expect(long.errors).toMatchObject({ name: { message: `Keep the name to ${ENTITY_LIMITS.nameMax} characters.` } });
  });
  it('checks each optional field against the shared limit, after trimming', async () => {
    const values = { ...createDefaults('Acme'), title: 't'.repeat(ENTITY_LIMITS.titleMax + 1), about: `  ${'a'.repeat(ENTITY_LIMITS.aboutMax)}  ` };
    const r = await run(resolveCreate, values);
    expect(r.errors).toMatchObject({ title: { message: `Keep the title to ${ENTITY_LIMITS.titleMax} characters.` } });
    expect(r.errors).not.toHaveProperty('about');
  });
  it('refuses a kind or role that is not in the shared lists', async () => {
    const r = await run(resolveCreate, { ...createDefaults('Acme'), kind: 'guild', role: 'mentor' });
    expect(r.errors).toMatchObject({ kind: { message: 'Choose what kind of entity this is.' }, role: { message: 'Choose how you are linked to it.' } });
  });
  it('hands the form tidied values, and the request blank fields as null', async () => {
    const r = await run(resolveCreate, { ...createDefaults('  Acme   Ltd '), title: ' CEO ', website: ' acme.com ', size: '11-50' });
    expect(r.errors).toEqual({});
    expect(createBody(r.values as ReturnType<typeof createDefaults>)).toEqual({
      name: 'Acme Ltd', kind: 'company', role: 'founder', title: 'CEO', location: null, size: '11-50', about: null, website: 'acme.com',
    });
  });
  it('the role form starts from your link as it is; a title it did not touch is not sent (kept), a cleared one is sent as null', async () => {
    expect(roleDefaults('advisor', null)).toEqual({ role: 'advisor', title: '' });
    expect(roleDefaults('founder', 'CEO')).toEqual({ role: 'founder', title: 'CEO' });
    const resolveRole = formResolver(roleSchema);
    const ok = await run(resolveRole, { role: 'investor', title: '  ' });
    expect(ok.errors).toEqual({});
    expect(roleBody(ok.values as ReturnType<typeof roleDefaults>, true)).toEqual({ role: 'investor', title: null });
    expect(roleBody({ role: 'partner', title: ' Chair ' }, true)).toEqual({ role: 'partner', title: 'Chair' });
    // Untouched: the page may not know the title at all (a member past the first 200 people), and must not clear it.
    expect(roleBody({ role: 'partner', title: '' }, false)).toEqual({ role: 'partner' });
    const bad = await run(resolveRole, { role: 'mentor', title: 'x'.repeat(ENTITY_LIMITS.titleMax + 1) });
    expect(bad.errors).toMatchObject({ role: { message: 'Choose how you are linked to it.' }, title: { message: `Keep the title to ${ENTITY_LIMITS.titleMax} characters.` } });
  });
  it('the edit form starts from the entity, and sends only what was changed (blank clears)', async () => {
    const start = editDefaults({ name: 'Acme', kind: 'startup', location: null, size: 'Seed stage', about: 'Hi', website: 'https://acme.com' });
    expect(start).toEqual({ name: 'Acme', kind: 'startup', location: '', size: 'Seed stage', about: 'Hi', website: 'https://acme.com' });
    const ok = await run(resolveEdit, { ...start, name: ' Acme  Two ', about: '  ' });
    expect(ok.errors).toEqual({});
    expect(editChanges(ok.values as typeof start, { name: true, about: true })).toEqual({ name: 'Acme Two', about: null });
    expect(editChanges(start, {})).toEqual({});
    expect(editChanges({ ...start, kind: 'fund', location: 'Oslo', size: '', website: '' }, { kind: true, location: true, size: true, website: true }))
      .toEqual({ kind: 'fund', location: 'Oslo', size: null, website: null });
  });
});

// ── entity-api.ts, run for real with a recording stand-in for the HTTP client ─────────────────────

interface RecordedCall { method: string; url: string; body?: unknown; config?: unknown }
interface EntityApi {
  fetchEntities: (term: string) => Promise<unknown>;
  fetchEntity: (id: string) => Promise<unknown>;
  createEntity: (body: unknown) => Promise<unknown>;
  updateEntity: (id: string, changes: unknown) => Promise<unknown>;
  archiveEntity: (id: string) => Promise<unknown>;
  setMyEntityRole: (id: string, role: string, title?: string | null) => Promise<unknown>;
  leaveEntity: (id: string) => Promise<unknown>;
  fetchPersonEntities: (userId: string) => Promise<unknown>;
  entityKeys: {
    all: readonly string[]; list: (t: string) => readonly string[]; page: (id: string) => readonly string[];
    person: (userId: string) => readonly string[];
  };
}

function loadEntityApi(): { api: EntityApi; exported: string[]; calls: RecordedCall[] } {
  const dir = path.join(__dirname, '../../../../client/src/features/reason/entities');
  const calls: RecordedCall[] = [];
  const answer = (method: string, hasBody: boolean) => (url: string, a?: unknown, b?: unknown) => {
    calls.push(hasBody ? { method, url, body: a, config: b } : { method, url, config: a });
    return Promise.resolve({ data: { data: null } });
  };
  const fakeClient = { get: answer('GET', false), post: answer('POST', true), patch: answer('PATCH', true), delete: answer('DELETE', false) };
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(dir, 'entity-api.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
  });
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  const load = (id: string): unknown => (id === '@/lib/api' ? { __esModule: true, default: fakeClient } : require(path.resolve(dir, id)));
  const run = vm.runInNewContext(`(function (module, exports, require) {${outputText}\n})`) as (m: unknown, e: unknown, r: unknown) => void;
  run(mod, mod.exports, load);
  return { api: mod.exports as unknown as EntityApi, exported: Object.keys(mod.exports).sort(), calls };
}

describe('the entities api: the contract\'s addresses, an id is data and never part of the path', () => {
  const crafted = '../users/me?';
  const encoded = '..%2Fusers%2Fme%3F';

  it('asks the contract\'s addresses with the contract\'s bodies', async () => {
    const { api, calls } = loadEntityApi();
    await api.fetchEntities('');
    await api.fetchEntities('acme');
    await api.fetchEntity(ID);
    await api.createEntity({ name: 'Acme', kind: 'company', role: 'founder' });
    await api.updateEntity(ID, { about: null });
    await api.archiveEntity(ID);
    await api.setMyEntityRole(ID, 'advisor', 'Chair');
    await api.setMyEntityRole(ID, 'advisor');
    await api.leaveEntity(ID);
    await api.fetchPersonEntities(ID);
    expect(calls).toEqual([
      { method: 'GET', url: '/entities', config: { params: {} } },
      { method: 'GET', url: '/entities', config: { params: { q: 'acme' } } },
      { method: 'GET', url: `/entities/${ID}`, config: undefined },
      { method: 'POST', url: '/entities', body: { name: 'Acme', kind: 'company', role: 'founder' }, config: undefined },
      { method: 'PATCH', url: `/entities/${ID}`, body: { about: null }, config: undefined },
      { method: 'DELETE', url: `/entities/${ID}`, config: undefined },
      { method: 'POST', url: `/entities/${ID}/members`, body: { role: 'advisor', title: 'Chair' }, config: undefined },
      // A title left out keeps the one on record (the contract), so it is not sent as null.
      { method: 'POST', url: `/entities/${ID}/members`, body: { role: 'advisor' }, config: undefined },
      { method: 'DELETE', url: `/entities/${ID}/members/me`, config: undefined },
      // A person's own entities (Your profile reads yours).
      { method: 'GET', url: `/users/${ID}/entities`, config: undefined },
    ]);
  });
  it('puts an id into every address as one encoded segment', async () => {
    const { api, calls } = loadEntityApi();
    await api.fetchEntity(crafted);
    await api.updateEntity(crafted, {});
    await api.archiveEntity(crafted);
    await api.setMyEntityRole(crafted, 'member');
    await api.leaveEntity(crafted);
    await api.fetchPersonEntities(crafted);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /entities/${encoded}`, `PATCH /entities/${encoded}`, `DELETE /entities/${encoded}`,
      `POST /entities/${encoded}/members`, `DELETE /entities/${encoded}/members/me`, `GET /users/${encoded}/entities`,
    ]);
  });
  it('keys every query under one root, so a write can refresh them all at once', () => {
    const { api } = loadEntityApi();
    expect(api.entityKeys.all).toEqual(['reason', 'entities']);
    expect(api.entityKeys.list('acme')).toEqual(['reason', 'entities', 'list', 'acme']);
    expect(api.entityKeys.page(ID)).toEqual(['reason', 'entities', 'page', ID]);
    expect(api.entityKeys.person(ID)).toEqual(['reason', 'entities', 'person', ID]);
  });
  it('exports exactly what the pages import', () => {
    expect(loadEntityApi().exported).toEqual([
      'archiveEntity', 'createEntity', 'entityKeys', 'fetchEntities', 'fetchEntity', 'fetchPersonEntities', 'leaveEntity',
      'setMyEntityRole', 'updateEntity',
    ]);
  });
});
