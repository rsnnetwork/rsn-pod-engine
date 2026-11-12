// ─── The event link: /events/<name>-<n>[-<tail>] (Stefan, 11 Nov 2026; event-link.service.ts) ────────────────────────
//
// The real services (event-link.service.ts, call-link.service.ts) run against the in-memory world
// (fixtures/call-link-world.ts), which answers each statement atomically, as Postgres answers one statement on one row:
// interleaved awaits there expose any read-then-write race in the service. The statements themselves run on real
// Postgres in the task's scratch run (two transactions at once included) and on PGlite for migration 154.

jest.mock('../../../config', () => {
  const cfg = {
    jwtSecret: 'test-jwt-secret', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', magicLinkExpiryMinutes: 60,
    clientUrl: 'https://app.rsn.network', env: 'test', isDev: false, isProd: false, isTest: true,
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 100000, eventLinkBaseUrl: '',
  };
  return { default: cfg, config: cfg, __esModule: true };
});
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../db', () => {
  const w = jest.requireActual('../../fixtures/call-link-world');
  const run = (sql: string, params?: unknown[]) => Promise.resolve().then(() => w.answer(sql, params));
  return { query: run, transaction: (cb: (c: unknown) => Promise<unknown>) => cb({ query: run }), __esModule: true };
});
const mockEmit = jest.fn();
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...a: unknown[]) => mockEmit(...a),
  getRealtimeIo: () => ({}),
  __esModule: true,
}));
jest.mock('../../../services/roles/effective-role.service', () => ({
  canActAsHost: (userId: string) => Promise.resolve({ allowed: userId === '00000000-0000-4000-8000-000000000001', effectiveRole: 'participant' }),
  __esModule: true,
}));
jest.mock('../../../services/post-event-message/event-organisers', () => ({
  resolveEventOrganiserIds: jest.fn().mockResolvedValue(['00000000-0000-4000-8000-000000000001']),
  __esModule: true,
}));
jest.mock('../../../services/session/event-groups.service', () => ({
  getEventGroupRules: () => Promise.resolve(null),
  __esModule: true,
}));
jest.mock('../../../services/session/event-access', () => {
  const actual = jest.requireActual('../../../services/session/event-access');
  const w = jest.requireActual('../../fixtures/call-link-world');
  return { ...actual, readEventAccessFacts: (sessionId: string, userId: string) => Promise.resolve(w.factsOf(sessionId, userId)) };
});

import { UserRole, parseEventLinkSlug } from '@rsn/shared';
import config from '../../../config';
import {
  CALL_LINK_NOT_FOUND, findCallEvent, getCallLanding, getCallLinkForOrganiser, resolveCallCode, rotateCallCode,
} from '../../../services/session/call-link.service';
import {
  checkEventLinkName, ensureEventLink, eventLinkBaseUrl, eventLinkMatchSql, eventLinkNeedsTailSql, refreshEventLinksOf,
} from '../../../services/session/event-link.service';
import { hasOwnBucket } from '../../../middleware/rateLimit';
import fs from 'fs';
import path from 'path';
import { addEvent, addUser, resetWorld, slugOf, uuid, world } from '../../fixtures/call-link-world';

const HOST = uuid(1);
const MEMBER = uuid(2);
const EVENT = uuid(100);
const host = { userId: HOST, role: UserRole.MEMBER };
const cfg = config as unknown as { eventLinkBaseUrl: string };

async function refusal(p: Promise<unknown>) {
  try { await p; return 'ok'; } catch (e) { const x = e as { statusCode?: number; code?: string; message?: string }; return { status: x.statusCode, code: x.code, message: x.message }; }
}
const landingOf = (key: string) => getCallLanding(key, null);
const eventOf = (id = EVENT) => world.events.find((e) => e.id === id)!;

beforeEach(() => {
  resetWorld();
  addUser({ id: HOST, email: 'host@example.org', display_name: 'Stefan Host' });
  addUser({ id: MEMBER, email: 'member@example.org', display_name: 'Ana Member' });
  mockEmit.mockReset().mockResolvedValue(undefined);
  cfg.eventLinkBaseUrl = '';
});

describe('a public event', () => {
  it('opens at /events/<name>-<n>; the landing gives the event link as its key, never the call code', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public' });
    expect(slugOf(eventOf())).toBe('rsn-1');
    const landing = await landingOf('rsn-1');
    expect(landing.title).toBe('Founders breakfast');
    expect(landing.code).toBe('rsn-1');
    expect(landing.link).toEqual({ slug: 'rsn-1', path: '/events/rsn-1' });
    expect(JSON.stringify(landing)).not.toContain('k7m2x9q4ra');
    expect((await findCallEvent('RSN-1'))?.id).toBe(EVENT);
  });

  it('a second event under the same name gets the next number, and each link opens its own event', async () => {
    addEvent({ id: uuid(200), call_code: 'aaaaaaaaaa', visibility: 'public', link_name: null, link_number: null, link_tail: null });
    addEvent({ id: uuid(201), call_code: 'bbbbbbbbbb', visibility: 'public', link_name: null, link_number: null, link_tail: null });
    world.counters.set('founders', 4);
    expect(await ensureEventLink(uuid(200), 'founders')).toEqual({ name: 'founders', number: 5, tail: null });
    expect(await ensureEventLink(uuid(201), 'founders')).toEqual({ name: 'founders', number: 6, tail: null });
    expect((await landingOf('founders-5')).link?.slug).toBe('founders-5');
    expect((await findCallEvent('founders-6'))?.id).toBe(uuid(201));
  });

  it('twenty events given their links at once under one name get twenty different numbers, 1 to 20 (no read-then-write)', async () => {
    for (let i = 0; i < 20; i++) {
      addEvent({ id: uuid(300 + i), call_code: `a${String(i).padStart(9, '2')}`.slice(0, 10), visibility: 'public', link_name: null, link_number: null, link_tail: null });
    }
    const given = await Promise.all(Array.from({ length: 20 }, (_, i) => ensureEventLink(uuid(300 + i), 'meetup')));
    expect(given.map((p) => p.number).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(world.counters.get('meetup')).toBe(20);
  });
});

describe('a private or invitation-only event', () => {
  it('gets a tail; the tailed link opens it, the link without the tail or with a wrong tail is the same 404 as an unknown code', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'private' });
    const tail = eventOf().link_tail!;
    expect(tail).toMatch(/^[a-km-np-z][2-9a-km-np-z]{5}$/);
    expect((await landingOf(`rsn-1-${tail}`)).link).toEqual({ slug: `rsn-1-${tail}`, path: `/events/rsn-1-${tail}` });
    const unknownCode = await refusal(landingOf('zzzzzzzzzz'));
    expect(unknownCode).toEqual({ status: 404, code: 'SESSION_NOT_FOUND', message: CALL_LINK_NOT_FOUND });
    const other = tail === 'abcdef' ? 'abcdeg' : 'abcdef';
    for (const key of ['rsn-1', `rsn-1-${other}`, 'rsn-2', 'rsn-1-k7m2', 'nobody-1', 'rsn', 'rsn-0']) {
      expect(await refusal(landingOf(key))).toEqual(unknownCode);
    }
  });

  it('an invitation-only event on a public event page still gets a tail (Stefan: private and invitation-only)', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public', admission_mode: 'restricted' });
    expect(eventOf().link_tail).not.toBeNull();
    expect(await refusal(landingOf('rsn-1'))).toMatchObject({ status: 404, message: CALL_LINK_NOT_FOUND });
  });

  it('an event that follows a public pod is public; one that follows a private pod is not', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: null, pod_visibility: 'public', admission_mode: null });
    addEvent({ id: uuid(101), call_code: 'cccccccccc', visibility: null, pod_visibility: 'private', admission_mode: null });
    expect(slugOf(eventOf())).toBe('rsn-1');
    expect(eventOf(uuid(101)).link_tail).not.toBeNull();
  });

  it('a draft opens by its event link only for the people who run it, as by its call code', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public', publication: 'draft' });
    expect(await refusal(landingOf('rsn-1'))).toMatchObject({ status: 404, message: CALL_LINK_NOT_FOUND });
    expect((await getCallLanding('rsn-1', { userId: HOST, role: UserRole.MEMBER })).lifecycle).toBe('draft');
    expect(await resolveCallCode('rsn-1')).toBeNull();
  });
});

describe('changing the visibility', () => {
  it('public to private: a tail is added and the link without it stops at once, with nothing forwarding it', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public' });
    eventOf().visibility = 'private';
    // Before anything writes, the open already refuses the guessable link (the rule is read on every open).
    expect(await refusal(landingOf('rsn-1'))).toMatchObject({ status: 404 });
    const parts = await ensureEventLink(EVENT);
    expect(parts).toEqual({ name: 'rsn', number: 1, tail: expect.stringMatching(/^[a-km-np-z][2-9a-km-np-z]{5}$/) });
    expect(world.aliases).toEqual([]);
    expect(await refusal(landingOf('rsn-1'))).toMatchObject({ status: 404 });
    expect((await landingOf(`rsn-1-${parts.tail}`)).title).toBe('Founders breakfast');
    // The organisers' card and the event page are told.
    expect(mockEmit.mock.calls.some(([, , tags]) => (tags as string[]).includes(`session:${EVENT}:call-link`))).toBe(true);
  });

  it('ruling (a), 12 Nov 2026: a call link given out while public stops too, the same 404, and the event gets a new code', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public' });
    expect(eventOf().call_code_private).toBe(false);
    const unknown = await refusal(landingOf('zzzzzzzzzz'));
    eventOf().visibility = 'private';
    // Refused at once, before anything is written (the rule is read on every open), exactly as the bare link.
    expect(await refusal(landingOf('k7m2x9q4ra'))).toEqual(unknown);
    expect(await refusal(landingOf('rsn-1'))).toEqual(unknown);
    // The organiser's card puts it right: a tail, and a new code given while private, which opens the event.
    const card = await getCallLinkForOrganiser(EVENT, host);
    expect(card.code).not.toBe('k7m2x9q4ra');
    expect(eventOf().call_code_private).toBe(true);
    expect((await landingOf(card.code)).title).toBe('Founders breakfast');
    expect((await landingOf(card.eventLink!.slug)).title).toBe('Founders breakfast');
    expect(await refusal(landingOf('k7m2x9q4ra'))).toEqual(unknown);
    // Turning public again makes the new code a public one, so it stops if the event turns private once more.
    eventOf().visibility = 'public';
    await ensureEventLink(EVENT);
    expect(eventOf().call_code_private).toBe(false);
    eventOf().visibility = 'private';
    expect(await refusal(landingOf(card.code))).toEqual(unknown);
  });

  it('ruling (a): invitation-only does the same to a public event\'s old call link', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public', admission_mode: 'open' });
    eventOf().admission_mode = 'restricted';
    expect(await refusal(landingOf('k7m2x9q4ra'))).toMatchObject({ status: 404, message: CALL_LINK_NOT_FOUND });
  });

  it('a code given while the event was private keeps working while it stays private', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'private' });
    expect(eventOf().call_code_private).toBe(true);
    const landing = await landingOf('k7m2x9q4ra');
    expect(landing.code).toBe('k7m2x9q4ra');
    expect(landing.link?.slug).toBe(`rsn-1-${eventOf().link_tail}`);
  });

  it('private to public: the tail is dropped, and the tailed link still leads to the event (it was given out)', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'private' });
    const tail = eventOf().link_tail!;
    eventOf().visibility = 'public';
    expect(await ensureEventLink(EVENT)).toEqual({ name: 'rsn', number: 1, tail: null });
    expect(world.aliases).toEqual([expect.objectContaining({ slug: `rsn-1-${tail}`, session_id: EVENT, secret: true })]);
    const landing = await landingOf(`rsn-1-${tail}`);
    expect(landing.link).toEqual({ slug: 'rsn-1', path: '/events/rsn-1' });
    expect(landing.code).toBe('rsn-1');
    expect((await landingOf('rsn-1')).title).toBe('Founders breakfast');
  });
});

describe('renaming', () => {
  it('takes the next number under the new name; the old link leads to the event and shows the new one', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public' });
    world.counters.set('founders', 2);
    expect(await ensureEventLink(EVENT, 'founders')).toEqual({ name: 'founders', number: 3, tail: null });
    const old = await landingOf('rsn-1');
    expect(old.link).toEqual({ slug: 'founders-3', path: '/events/founders-3' });
    expect(old.code).toBe('founders-3');
    expect((await landingOf('founders-3')).title).toBe('Founders breakfast');
  });

  it('renaming back takes the event\'s own old number again, not a new one', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public' });
    await ensureEventLink(EVENT, 'founders');
    expect(await ensureEventLink(EVENT, 'rsn')).toEqual({ name: 'rsn', number: 1, tail: null });
    expect(world.counters.get('rsn')).toBe(1);
    expect((await landingOf('founders-1')).link?.slug).toBe('rsn-1');
  });

  it('a private event keeps its tail under the new name; its old tailed link leads to it', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'private' });
    const tail = eventOf().link_tail!;
    expect(await ensureEventLink(EVENT, 'founders')).toEqual({ name: 'founders', number: 1, tail });
    expect((await landingOf(`rsn-1-${tail}`)).link?.slug).toBe(`founders-1-${tail}`);
    expect(await refusal(landingOf('founders-1'))).toMatchObject({ status: 404 });
  });

  it('a link renamed while public stops once the event turns private (it never had a tail)', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public' });
    await ensureEventLink(EVENT, 'founders');
    eventOf().visibility = 'private';
    const parts = await ensureEventLink(EVENT);
    expect(await refusal(landingOf('rsn-1'))).toMatchObject({ status: 404, message: CALL_LINK_NOT_FOUND });
    expect(await refusal(landingOf('founders-1'))).toMatchObject({ status: 404 });
    expect((await landingOf(`founders-1-${parts.tail}`)).title).toBe('Founders breakfast');
  });

  it('naming it what it is already called changes nothing', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public' });
    world.writes = [];
    expect(await ensureEventLink(EVENT, 'rsn')).toEqual({ name: 'rsn', number: 1, tail: null });
    expect(world.writes).toEqual([]);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('rotating the call link', () => {
  it('draws a new tail; the old tailed link and every old tailed alias stop; the call code is new too', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'private' });
    const tail = eventOf().link_tail!;
    await ensureEventLink(EVENT, 'founders');
    await rotateCallCode(EVENT, host);
    const fresh = eventOf().link_tail!;
    expect(fresh).not.toBe(tail);
    expect(world.aliases.filter((a) => a.secret)).toEqual([]);
    for (const old of [`rsn-1-${tail}`, `founders-1-${tail}`, 'k7m2x9q4ra']) {
      expect(await refusal(landingOf(old))).toMatchObject({ status: 404, message: CALL_LINK_NOT_FOUND });
    }
    expect((await landingOf(`founders-1-${fresh}`)).title).toBe('Founders breakfast');
  });

  it('leaves a public link as it is (nothing secret to rotate)', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public' });
    await rotateCallCode(EVENT, host);
    expect((await landingOf('rsn-1')).title).toBe('Founders breakfast');
  });
});

describe('the old call link keeps working', () => {
  it('/call/<code> opens the event as before (its key stays the code) and names the event link to show instead', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public' });
    const landing = await landingOf('K7M2-X9Q4-RA');
    expect(landing.code).toBe('k7m2x9q4ra');
    expect(landing.link).toEqual({ slug: 'rsn-1', path: '/events/rsn-1' });
  });

  it('a code typed with a dash that looks like a slug still opens its event', async () => {
    addEvent({ id: EVENT, call_code: 'abcde23456', visibility: 'public' });
    expect(parseEventLinkSlug('abcde-23456')).not.toBeNull();
    expect((await landingOf('abcde-23456')).code).toBe('abcde23456');
  });

  it('an event made before migration 154 (no link yet) gets one the first time its call link is opened', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public', link_name: null, link_number: null, link_tail: null });
    const landing = await landingOf('k7m2x9q4ra');
    expect(landing.link?.slug).toBe('event-1');
  });

  it('the default name is the pod\'s latest public event\'s; else rsn for a platform admin\'s event and event for anyone else\'s', async () => {
    addEvent({ id: uuid(110), call_code: 'aaaaaaaaaa', visibility: 'public' });
    await ensureEventLink(uuid(110), 'founders');
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public', link_name: null, link_number: null, link_tail: null });
    expect(await ensureEventLink(EVENT)).toEqual({ name: 'founders', number: 2, tail: null });
    addEvent({ id: uuid(111), call_code: 'cccccccccc', visibility: 'public', pod_id: 'pod-2', link_name: null, link_number: null, link_tail: null });
    expect((await ensureEventLink(uuid(111))).name).toBe('event');
    addUser({ id: uuid(9), email: 'admin@example.org', role: 'admin' });
    addEvent({ id: uuid(112), call_code: 'dddddddddd', visibility: 'public', pod_id: 'pod-3', host_user_id: uuid(9), link_name: null, link_number: null, link_tail: null });
    expect((await ensureEventLink(uuid(112))).name).toBe('rsn');
    expect(JSON.stringify(world.events)).not.toMatch(/secret-pod/);
  });

  it('review I1: a private event\'s name is never carried into a public event\'s link (nor a draft\'s)', async () => {
    addEvent({ id: uuid(120), call_code: 'aaaaaaaaaa', visibility: 'private' });
    await ensureEventLink(uuid(120), 'acme-acquisition');
    addEvent({ id: uuid(121), call_code: 'bbbbbbbbbb', visibility: 'public', publication: 'draft' });
    await ensureEventLink(uuid(121), 'draft-name');
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public', link_name: null, link_number: null, link_tail: null });
    const parts = await ensureEventLink(EVENT);
    expect(parts.name).toBe('event');
    expect(JSON.stringify(await landingOf('k7m2x9q4ra'))).not.toMatch(/acme|draft-name/);
  });

  it('a platform admin\'s pod series named rsn is not carried into another organiser\'s event', async () => {
    addUser({ id: uuid(9), email: 'admin@example.org', role: 'admin' });
    addEvent({ id: uuid(130), call_code: 'aaaaaaaaaa', visibility: 'public', host_user_id: uuid(9) });
    expect(eventOf(uuid(130)).link_name).toBe('rsn');
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public', link_name: null, link_number: null, link_tail: null });
    expect((await ensureEventLink(EVENT)).name).toBe('event');
  });

  it('a string that is neither a slug nor a code reaches no database', async () => {
    world.sql = [];
    for (const raw of ["'; DROP TABLE sessions; --", 'rsn-1/../x', '', 'x'.repeat(200)]) {
      expect(await findCallEvent(raw)).toBeNull();
    }
    expect(world.sql).toEqual([]);
  });
});

describe('the organisers\' card', () => {
  it('when the event link cannot be read, the card gets a 503, never a call link that may be dead (rereview minor 1)', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public' });
    eventOf().visibility = 'private';
    const links = jest.requireActual('../../../services/session/event-link.service');
    const spy = jest.spyOn(links, 'eventLinkInfo').mockRejectedValueOnce(new Error('connection reset'));
    try {
      expect(await refusal(getCallLinkForOrganiser(EVENT, host))).toMatchObject({ status: 503, message: 'We could not read the event link just now. Please try again.' });
    } finally {
      spy.mockRestore();
    }
  });

  it('carries the event link, whether it has a tail, and the address on the site asked from', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'private' });
    const tail = eventOf().link_tail!;
    const card = await getCallLinkForOrganiser(EVENT, host, { origin: 'https://preview.rsn.network' });
    expect(card.eventLink).toEqual({
      name: 'rsn', number: 1, slug: `rsn-1-${tail}`, path: `/events/rsn-1-${tail}`,
      url: `https://preview.rsn.network/events/rsn-1-${tail}`, private: true,
    });
  });

  it('EVENT_LINK_BASE_URL decides the site when it is an http(s) address; anything else is ignored', async () => {
    cfg.eventLinkBaseUrl = 'https://rsn.network/';
    expect(eventLinkBaseUrl('https://preview.rsn.network')).toBe('https://rsn.network');
    cfg.eventLinkBaseUrl = 'javascript:alert(1)';
    expect(eventLinkBaseUrl('https://preview.rsn.network')).toBe('https://preview.rsn.network');
    cfg.eventLinkBaseUrl = 'not a url';
    expect(eventLinkBaseUrl()).toBe('https://app.rsn.network');
    cfg.eventLinkBaseUrl = '';
    expect(eventLinkBaseUrl('https://evil.example')).toBe('https://app.rsn.network');
  });

  it('someone who does not run the event reads neither link', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'private' });
    expect(await refusal(getCallLinkForOrganiser(EVENT, { userId: MEMBER, role: UserRole.MEMBER }))).toMatchObject({ status: 403 });
  });
});

describe('the event form\'s link-name field', () => {
  it('editing: the default is the event\'s own name, the number its own; a new name shows the next number and the address', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public' });
    world.counters.set('founders', 7);
    expect(await checkEventLinkName(host, { sessionId: EVENT })).toEqual({
      defaultName: 'rsn', name: 'rsn', problem: null, nextNumber: 1, preview: 'https://app.rsn.network/events/rsn-1', private: false,
    });
    expect(await checkEventLinkName(host, { sessionId: EVENT, name: ' Founders ' }, { origin: 'https://preview.rsn.network' })).toEqual({
      defaultName: 'rsn', name: 'founders', problem: null, nextNumber: 8, preview: 'https://preview.rsn.network/events/founders-8', private: false,
    });
  });

  it('editing: the tail follows the visibility the form now shows, not only the one saved', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public' });
    expect((await checkEventLinkName(host, { sessionId: EVENT })).private).toBe(false);
    expect((await checkEventLinkName(host, { sessionId: EVENT, visibility: 'private' })).private).toBe(true);
    eventOf().admission_mode = 'restricted';
    expect((await checkEventLinkName(host, { sessionId: EVENT, visibility: 'public' })).private).toBe(true);
  });

  it('ruling (b): "rsn" is refused to anyone but a platform admin, though an event already named rsn keeps it', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public', link_name: 'founders', link_number: 1, link_tail: null });
    expect((await checkEventLinkName(host, { sessionId: EVENT, name: 'RSN' })).problem).toBe('This name is reserved.');
    expect((await checkEventLinkName({ userId: MEMBER, role: UserRole.SUPER_ADMIN }, { sessionId: EVENT, name: 'rsn' })).problem).toBeNull();
    addEvent({ id: uuid(140), call_code: 'aaaaaaaaaa', visibility: 'public' });
    expect(eventOf(uuid(140)).link_name).toBe('rsn');
    expect((await checkEventLinkName(host, { sessionId: uuid(140) })).problem).toBeNull();
  });

  it('a name that cannot be used says why, and offers no number', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'private' });
    expect(await checkEventLinkName(host, { sessionId: EVENT, name: 'admin' })).toMatchObject({
      name: 'admin', problem: 'That name is kept for REASON itself. Choose another.', nextNumber: null, preview: null, private: true,
    });
    expect((await checkEventLinkName(host, { sessionId: EVENT, name: 'my event' })).problem).toContain('Use 2 to 40');
  });

  it('only the host (or an admin) may ask about an event', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public' });
    expect(await refusal(checkEventLinkName({ userId: MEMBER, role: UserRole.MEMBER }, { sessionId: EVENT }))).toMatchObject({ status: 403 });
    expect((await checkEventLinkName({ userId: MEMBER, role: UserRole.ADMIN }, { sessionId: EVENT })).name).toBe('rsn');
  });
});

describe('a pod or circle that changes who may see its events (review M5)', () => {
  it('each of its events that has not ended is put right and its organisers\' card told', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: null, pod_visibility: 'public', admission_mode: null });
    addEvent({ id: uuid(150), call_code: 'aaaaaaaaaa', visibility: null, pod_visibility: 'public', admission_mode: null, status: 'completed' });
    expect(eventOf().link_tail).toBeNull();
    for (const e of world.events) e.pod_visibility = 'private';
    mockEmit.mockClear();
    await refreshEventLinksOf({ podId: 'pod-1' });
    expect(eventOf().link_tail).toMatch(/^[a-km-np-z][2-9a-km-np-z]{5}$/);
    expect(eventOf().call_code).not.toBe('k7m2x9q4ra');
    expect(eventOf(uuid(150)).link_tail).toBeNull();
    expect(mockEmit.mock.calls.some(([, , tags]) => (tags as string[]).includes(`session:${EVENT}:call-link`))).toBe(true);
  });

  it('one read for all the pod\'s events; only the unsettled are written; their guests are told too (rereview minor 3)', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: null, pod_visibility: 'public', admission_mode: null });
    addEvent({ id: uuid(151), call_code: 'aaaaaaaaaa', visibility: 'private', pod_visibility: 'public' });
    addEvent({ id: uuid(152), call_code: 'bbbbbbbbbb', visibility: 'public', pod_visibility: 'public' });
    world.places.set(`${EVENT}:${MEMBER}`, { status: 'registered', admitted_via: 'open' });
    for (const e of world.events) e.pod_visibility = 'private';
    world.sql = [];
    world.writes = [];
    mockEmit.mockClear();
    await refreshEventLinksOf({ podId: 'pod-1' });
    // One read of the pod's events; uuid(151) (private, settled) and uuid(152) (public by its own visibility) unwritten.
    expect(world.sql.filter((s) => s.includes('WHERE s.pod_id = $1'))).toHaveLength(1);
    expect(world.writes.filter((w) => w.startsWith('link:'))).toEqual([`link:${EVENT}`]);
    const toMember = mockEmit.mock.calls.filter(([, people]) => (people as string[])[0] === MEMBER).flatMap(([, , tags]) => tags as string[]);
    expect(toMember).toEqual(expect.arrayContaining([`session:${EVENT}:call-link`, `session:${EVENT}`, `user:${MEMBER}:sessions`]));
    // Each person gets only their own user tag.
    for (const [, people, tags] of mockEmit.mock.calls) {
      for (const tag of tags as string[]) if (tag.startsWith('user:')) expect(tag).toBe(`user:${(people as string[])[0]}:sessions`);
    }
  });

  it('it never throws, whatever fails', async () => {
    await expect(refreshEventLinksOf({ circleId: 'no-such-circle' })).resolves.toBeUndefined();
  });

  it('the pod and circle edits call it, in the background, only when who may see changed', () => {
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../services', rel), 'utf8');
    expect(read('pod/pod.service.ts')).toMatch(/if \('visibility' in input\) \{\s*void import\('\.\.\/session\/event-link\.service'\)\.then\(\(links\) => links\.refreshEventLinksOf\(\{ podId \}\)\)/);
    expect(read('circle/circle.service.ts')).toMatch(/if \(input\.joinPolicy === undefined\) return;\s*void import\('\.\.\/session\/event-link\.service'\)\.then\(\(links\) => links\.refreshEventLinksOf\(\{ circleId \}\)\)/);
  });
});

describe('the SQL the rules are written in', () => {
  it('the tail rule mirrors the public lists: own visibility, else the pod\'s; never invitation-only or a closed circle', () => {
    const sql = eventLinkNeedsTailSql('s').replace(/\s+/g, ' ');
    // NULL-safe (found on PGlite: NULL IN (...) is NULL, and NOT NULL is NULL, so an event following a private pod got
    // no tail): the visibility is tested for NULL first, and an unknown answer reads as needing a tail.
    expect(sql).toMatch(/^COALESCE\(NOT \(/);
    expect(sql).toMatch(/, TRUE\)$/);
    expect(sql).toContain("(s.visibility IS NOT NULL AND s.visibility IN ('public', 'public_with_approval'))");
    expect(sql).toContain("s.visibility IS NULL AND EXISTS (SELECT 1 FROM pods el_p WHERE el_p.id = s.pod_id AND el_p.visibility = 'public')");
    expect(sql).toContain("s.admission_mode IS DISTINCT FROM 'restricted'");
    expect(sql).toContain("el_c.join_policy = 'closed'");
    expect(() => eventLinkNeedsTailSql('s; DROP')).toThrow();
    expect(() => eventLinkNeedsTailSql('s', "'public'")).toThrow();
    expect(eventLinkNeedsTailSql('s', '$2')).toContain('COALESCE($2::text, s.visibility)');
  });

  it('a current link needs its exact tail and opens without one only while public; an old link with a tail always, without only while public', () => {
    const sql = eventLinkMatchSql().replace(/\s+/g, ' ');
    expect(sql).toContain('el_s.link_tail IS NOT DISTINCT FROM $3::text');
    expect(sql).toContain('(el_s.link_tail IS NOT NULL OR NOT');
    expect(sql).toContain('WHERE el_a.slug = $4 AND (el_a.secret OR NOT');
    expect(sql).toContain('ORDER BY el_m.rank LIMIT 1');
  });
});

describe('the request limits', () => {
  it('an event link\'s landing, code email and code check keep the venue-sized buckets the call link has', () => {
    for (const slug of ['rsn-3', 'rsn-3-k7m2q9', 'summit-2026-12']) {
      expect(hasOwnBucket('GET', `/api/call-links/${slug}`)).toBe(true);
      expect(hasOwnBucket('HEAD', `/api/call-links/${slug}?x=1`)).toBe(true);
      expect(hasOwnBucket('POST', `/api/call-links/${slug}/email`)).toBe(true);
      expect(hasOwnBucket('POST', `/api/call-links/${slug}/verify`)).toBe(true);
      expect(hasOwnBucket('POST', `/api/call-links/${slug}/enter`)).toBe(false);
      expect(hasOwnBucket('GET', `/api/call-links/${slug}/entry`)).toBe(false);
    }
    expect(hasOwnBucket('GET', '/api/sessions/event-link-name')).toBe(false);
  });
});
