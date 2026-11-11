// ─── The RSN Call link: its code and its landing (Part 2 foundation, Task 6, 11 Nov 2026; spec 04) ──────────
//
// The code: 50 bits from the operating system, in an alphabet that reads aloud, unique, given lazily to an old event
// and rotated by an organiser (the old link stops working at once). The landing: what anyone holding the link sees,
// never the participants, the pod or the invitees. The real service runs against the in-memory world
// (fixtures/call-link-world.ts).

jest.mock('../../../config', () => {
  const cfg = {
    jwtSecret: 'test-jwt-secret', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', magicLinkExpiryMinutes: 60,
    clientUrl: 'https://app.rsn.network', env: 'test', isDev: false, isProd: false, isTest: true,
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 100000,
  };
  return { default: cfg, config: cfg, __esModule: true };
});
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../db', () => {
  const w = jest.requireActual('../../fixtures/call-link-world');
  return {
    query: (sql: string, params?: unknown[]) => Promise.resolve().then(() => w.answer(sql, params)),
    transaction: (cb: (c: unknown) => Promise<unknown>) => cb({ query: (sql: string, params?: unknown[]) => Promise.resolve().then(() => w.answer(sql, params)) }),
    __esModule: true,
  };
});
const mockEmit = jest.fn();
jest.mock('../../../realtime/emit', () => ({
  emitEntities: (...a: unknown[]) => mockEmit(...a),
  getRealtimeIo: () => ({}),
  __esModule: true,
}));
const mockCanActAsHost = jest.fn();
jest.mock('../../../services/roles/effective-role.service', () => ({
  canActAsHost: (...a: unknown[]) => mockCanActAsHost(...a),
  __esModule: true,
}));
jest.mock('../../../services/post-event-message/event-organisers', () => ({
  resolveEventOrganiserIds: jest.fn().mockResolvedValue(['00000000-0000-4000-8000-000000000001']),
  __esModule: true,
}));
jest.mock('../../../services/session/event-groups.service', () => ({
  getEventGroupRules: (sessionId: string) => Promise.resolve(jest.requireActual('../../fixtures/call-link-world').world.rules.get(sessionId) ?? null),
  __esModule: true,
}));
jest.mock('../../../services/session/event-access', () => {
  const actual = jest.requireActual('../../../services/session/event-access');
  const w = jest.requireActual('../../fixtures/call-link-world');
  return { ...actual, readEventAccessFacts: (sessionId: string, userId: string) => Promise.resolve(w.factsOf(sessionId, userId)) };
});

import fs from 'fs';
import path from 'path';
import {
  CALL_CODE_ALPHABET, CALL_CODE_LENGTH, CALL_LINK_BASE_PATH, UserRole, callLinkPath, cleanCallDisplayName, normaliseCallCode,
} from '@rsn/shared';
import {
  CALL_LINK_NOT_FOUND, ensureCallCode, getCallLanding, getCallLinkForOrganiser, newCallCode, resolveCallCode, rotateCallCode,
} from '../../../services/session/call-link.service';
import { addEvent, addUser, resetWorld, uuid, world } from '../../fixtures/call-link-world';
import { firstAllowedClientBaseUrl } from '../../../services/identity/client-origin';

const CHECK = /^[0-9a-hjkmnp-tv-z]{10}$/; // migration 139's CHECK, verbatim
const HOST = uuid(1);
const MEMBER = uuid(2);
const EVENT = uuid(100);
const host = { userId: HOST, role: UserRole.MEMBER };

async function refusal(p: Promise<unknown>) {
  try { await p; return 'ok'; } catch (e) { const x = e as { statusCode?: number; code?: string; message?: string }; return { status: x.statusCode, code: x.code, message: x.message }; }
}

beforeEach(() => {
  resetWorld();
  addUser({ id: HOST, email: 'host@example.org', display_name: 'Stefan Host' });
  addUser({ id: MEMBER, email: 'member@example.org', display_name: 'Ana Member' });
  mockEmit.mockReset().mockResolvedValue(undefined);
  mockCanActAsHost.mockReset().mockImplementation((userId: string) => Promise.resolve({ allowed: userId === HOST, effectiveRole: userId === HOST ? 'event_host' : 'participant' }));
});

describe('the code', () => {
  it('10,000 new codes are all different and every one passes migration 139\'s CHECK', () => {
    const codes = Array.from({ length: 10_000 }, () => newCallCode());
    expect(new Set(codes).size).toBe(10_000);
    expect(codes.every((c) => CHECK.test(c))).toBe(true);
    expect(CALL_CODE_ALPHABET).toHaveLength(32);
    expect(CALL_CODE_LENGTH).toBe(10);
  });

  it('is drawn with crypto.randomInt, one symbol at a time (50 bits from the operating system)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'services/session/call-link.service.ts'), 'utf8');
    expect(src).toMatch(/crypto\.randomInt\(CALL_CODE_ALPHABET\.length\)/);
    expect(src).not.toMatch(/Math\.random/);
  });

  it('the alphabet and the CHECK say the same thing: no i, l, o or u', () => {
    expect([...CALL_CODE_ALPHABET].every((ch) => /^[0-9a-hjkmnp-tv-z]$/.test(ch))).toBe(true);
    for (const ch of 'ilou') expect(CALL_CODE_ALPHABET).not.toContain(ch);
    const mig = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'db/migrations/139_event_call_codes.sql'), 'utf8');
    expect(mig).toContain("call_code ~ '^[0-9a-hjkmnp-tv-z]{10}$'");
  });

  it('normaliseCallCode reads what people type', () => {
    expect(normaliseCallCode('K7M2-X9Q4-RA')).toBe('k7m2x9q4ra');
    expect(normaliseCallCode(' k7m2 x9q4 ra ')).toBe('k7m2x9q4ra');
    expect(normaliseCallCode('O1IL-0000-00')).toBe('0111000000');
    expect(normaliseCallCode('k7m2x9q4r')).toBeNull();      // too short
    expect(normaliseCallCode('k7m2x9q4raa')).toBeNull();    // too long
    expect(normaliseCallCode('k7m2x9q4ru')).toBeNull();     // u is not in the alphabet
    expect(normaliseCallCode('k7m2x9q4r!')).toBeNull();
    expect(normaliseCallCode('')).toBeNull();
    expect(normaliseCallCode('k'.repeat(41))).toBeNull();
    expect(normaliseCallCode('../../etc/x')).toBeNull();
  });

  it('the link path lives in one constant', () => {
    expect(CALL_LINK_BASE_PATH).toBe('/call');
    expect(callLinkPath('k7m2x9q4ra')).toBe('/call/k7m2x9q4ra');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', '..', 'shared/src/events/call-link.ts'), 'utf8');
    expect(src).toMatch(/Stefan still has to confirm/);
  });

  it('the details step\'s name rule', () => {
    expect(cleanCallDisplayName('  Ana   María  ')).toBe('Ana María');
    expect(cleanCallDisplayName('')).toBeNull();
    expect(cleanCallDisplayName('   ')).toBeNull();
    expect(cleanCallDisplayName('a'.repeat(60))).toBe('a'.repeat(60));
    expect(cleanCallDisplayName('a'.repeat(61))).toBeNull();
    expect(cleanCallDisplayName('<b>Ana</b>')).toBeNull();
    expect(cleanCallDisplayName('Ana\u0000')).toBeNull();
    // Invisible characters that can disguise a name are taken out, then the name is trimmed (fix rounds 1 and 2).
    const cp = (...codes: number[]) => String.fromCodePoint(...codes);
    expect(cleanCallDisplayName(`${cp(0x200b)}Ana${cp(0x200d)} ${cp(0x202e)}Maria${cp(0x202c, 0xfeff)} `)).toBe('Ana Maria');
    expect(cleanCallDisplayName(`${cp(0x2066)} Stefan ${cp(0x2069)}`)).toBe('Stefan');
    expect(cleanCallDisplayName(cp(0x200b, 0x200c, 0x200d, 0x2060))).toBeNull();
    // The Arabic letter mark, the line and paragraph separators and the Hangul fillers that draw as blank.
    expect(cleanCallDisplayName(`Ana${cp(0x061c)} ${cp(0x2028)}Bo${cp(0x2029)}`)).toBe('Ana Bo');
    expect(cleanCallDisplayName(cp(0x3164, 0x115f, 0x1160, 0xffa0))).toBeNull();
    expect(cleanCallDisplayName(`${cp(0x3164)}Stefan`)).toBe('Stefan');
  });
});

describe('ensureCallCode', () => {
  it('gives an old event a code once: asking twice returns the same code', async () => {
    addEvent({ id: EVENT, call_code: null as unknown as string });
    world.events[0].call_code = null;
    const first = await ensureCallCode(EVENT);
    const second = await ensureCallCode(EVENT);
    expect(first).toMatch(CHECK);
    expect(second).toBe(first);
    expect(world.writes.filter((w) => w === `code:${EVENT}`)).toHaveLength(1);
  });

  it('two first asks at once agree on one code (the guarded write)', async () => {
    addEvent({ id: EVENT, call_code: null as unknown as string });
    world.events[0].call_code = null;
    const [a, b] = await Promise.all([ensureCallCode(EVENT), ensureCallCode(EVENT)]);
    expect(a).toBe(b);
    expect(world.events[0].call_code).toBe(a);
  });

  it('an event that does not exist is the link\'s one 404', async () => {
    expect(await refusal(ensureCallCode(uuid(999)))).toMatchObject({ status: 404, message: CALL_LINK_NOT_FOUND });
  });
});

describe('rotateCallCode', () => {
  it('the old link stops working at once, the new one works, and the rotation is audited', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra' });
    const fresh = await rotateCallCode(EVENT, host);
    expect(fresh).toMatch(CHECK);
    expect(fresh).not.toBe('k7m2x9q4ra');
    expect(await resolveCallCode('k7m2x9q4ra')).toBeNull();
    expect(await resolveCallCode(fresh.toUpperCase())).toEqual({ sessionId: EVENT });
    expect(world.audit).toEqual([{ action: 'call_link.rotated', sessionId: EVENT }]);
    // The organisers' card is told.
    expect(mockEmit.mock.calls.some(([, , tags]) => (tags as string[]).includes(`session:${EVENT}:call-link`))).toBe(true);
  });

  it('someone who does not run the event cannot rotate it or read it', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra' });
    const member = { userId: MEMBER, role: UserRole.MEMBER };
    expect(await refusal(rotateCallCode(EVENT, member))).toMatchObject({ status: 403 });
    expect(await refusal(getCallLinkForOrganiser(EVENT, member))).toMatchObject({ status: 403 });
    expect(world.events[0].call_code).toBe('k7m2x9q4ra');
    expect(world.audit).toEqual([]);
  });

  it('the organiser reads the code, the path and the full address, and (added) the event link', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', visibility: 'public' });
    expect(await getCallLinkForOrganiser(EVENT, host)).toEqual({
      code: 'k7m2x9q4ra', path: '/call/k7m2x9q4ra', url: 'https://app.rsn.network/call/k7m2x9q4ra',
      eventLink: {
        name: 'rsn', number: 1, slug: 'rsn-1', path: '/events/rsn-1', url: 'https://app.rsn.network/events/rsn-1', private: false,
      },
    });
  });

  it('the address is on the site the organiser asked from when it is ours (the preview), else the main app', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra' });
    expect((await getCallLinkForOrganiser(EVENT, host, { origin: 'https://preview.rsn.network' })).url)
      .toBe('https://preview.rsn.network/call/k7m2x9q4ra');
    for (const origin of ['https://evil.example', 'https://x-rsnnetwork.vercel.app', 'https://api.rsn.network', 'http://localhost:5173', 'nonsense']) {
      expect((await getCallLinkForOrganiser(EVENT, host, { origin })).url).toBe('https://app.rsn.network/call/k7m2x9q4ra');
    }
  });
});

describe('firstAllowedClientBaseUrl (client-origin.ts)', () => {
  const cfg = { clientUrl: 'https://app.rsn.network', isDev: false };
  it('answers the first of the asking addresses that is on sign-in\'s exact list, as its origin, else the main app', () => {
    expect(firstAllowedClientBaseUrl(['https://preview.rsn.network/call/x?y=1'], cfg)).toBe('https://preview.rsn.network');
    expect(firstAllowedClientBaseUrl(['https://evil.example', 'https://preview.rsn.network'], cfg)).toBe('https://preview.rsn.network');
    expect(firstAllowedClientBaseUrl([undefined, null, ''], cfg)).toBe('https://app.rsn.network');
    expect(firstAllowedClientBaseUrl(['https://preview.rsn.network.evil.example', 'https://x-rsnnetwork.vercel.app'], cfg)).toBe('https://app.rsn.network');
    expect(firstAllowedClientBaseUrl(['http://localhost:5173'], cfg)).toBe('https://app.rsn.network');
    expect(firstAllowedClientBaseUrl(['http://localhost:5173'], { ...cfg, isDev: true })).toBe('http://localhost:5173');
  });
});


describe('resolveCallCode', () => {
  it('null for a malformed, unknown or draft code; the event for a published one', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra' });
    addEvent({ id: uuid(101), call_code: 'aaaaaaaaaa', publication: 'draft' });
    expect(await resolveCallCode('k7m2x9q4ra')).toEqual({ sessionId: EVENT });
    expect(await resolveCallCode('nope')).toBeNull();
    expect(await resolveCallCode('bbbbbbbbbb')).toBeNull();
    expect(await resolveCallCode('aaaaaaaaaa')).toBeNull();
  });

  it('a malformed code reaches no database at all', async () => {
    world.sql = [];
    expect(await resolveCallCode("'; DROP TABLE sessions; --")).toBeNull();
    expect(world.sql).toEqual([]);
  });
});

describe('the landing', () => {
  it('shows the event as anyone holding the link sees it, and nothing about who else is in it', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', admission_mode: 'restricted', visibility: 'private' });
    world.places.set(`${EVENT}:${MEMBER}`, { status: 'registered', admitted_via: 'invite' });
    world.invites.push({ session_id: EVENT, invitee_email: 'invitee@example.org', max_uses: 1, status: 'pending', expires_at: null });
    world.sql = [];
    const landing = await getCallLanding('K7M2-X9Q4-RA', null);
    expect(landing).toEqual({
      code: 'k7m2x9q4ra',
      title: 'Founders breakfast',
      description: 'Coffee and introductions',
      scheduledAt: world.events[0].scheduled_at!.toISOString(),
      // Part 3 Task 1 (additive): the event's zone (none on this row: UTC) and its image (none).
      timezone: 'UTC',
      imageUrl: null,
      durationMinutes: expect.any(Number),
      format: 'speed_networking',
      host: { displayName: 'Stefan Host', avatarUrl: null },
      lifecycle: 'registration_open',
      admission: 'restricted',
      asks: { displayName: true, group: null, admissionCode: true, questions: null },
      viewer: { signedIn: false, accountKind: null, sessionId: null, step: 'identify' },
      // The event link as it is now (additive): a private event's carries its tail.
      link: { slug: `rsn-1-${world.events[0].link_tail}`, path: `/events/rsn-1-${world.events[0].link_tail}` },
    });
    const text = JSON.stringify(landing);
    for (const hidden of ['Secret Pod Name', 'pod-1', 'Ana Member', 'member@example.org', 'invitee@example.org', 'host@example.org', HOST, EVENT]) {
      expect(text).not.toContain(hidden);
    }
    // It never reads the participants, the invites or the pod to build it (the event link's tail rule reads only whether
    // the pod is public, inside the event's own row: FROM pods el_p).
    expect(world.sql.some((s) => /session_participants|invites|FROM pods (?!el_p )/.test(s))).toBe(false);
  });

  it('a cancelled event shows lifecycle cancelled; an ended one completed', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra', status: 'cancelled' });
    addEvent({ id: uuid(101), call_code: 'cccccccccc', status: 'completed' });
    expect((await getCallLanding('k7m2x9q4ra', null)).lifecycle).toBe('cancelled');
    expect((await getCallLanding('cccccccccc', null)).lifecycle).toBe('completed');
  });

  it('an event with groups shows its question and answers', async () => {
    addEvent({ id: EVENT, call_code: 'k7m2x9q4ra' });
    world.rules.set(EVENT, {
      groups: [{ key: 'founder', label: 'Founders', description: null }, { key: 'funder', label: 'Funders', description: null }],
      question: 'Which are you?', allowMultiple: false, fallback: 'leave_unmatched', rounds: [],
    });
    expect((await getCallLanding('k7m2x9q4ra', null)).asks.group).toEqual({
      question: 'Which are you?', multiple: false,
      options: [{ key: 'founder', label: 'Founders' }, { key: 'funder', label: 'Funders' }],
    });
  });

  it('malformed, unknown, a draft (to anyone who does not run it) and a deleted event: the same 404', async () => {
    addEvent({ id: EVENT, call_code: 'dddddddddd', publication: 'draft' });
    const answers = await Promise.all([
      refusal(getCallLanding('not-a-code', null)),
      refusal(getCallLanding('zzzzzzzzzz', null)),
      refusal(getCallLanding('dddddddddd', null)),
      refusal(getCallLanding('dddddddddd', { userId: MEMBER, role: UserRole.MEMBER })),
    ]);
    world.events = []; // the event is deleted for good
    answers.push(await refusal(getCallLanding('dddddddddd', null)));
    for (const a of answers) expect(a).toEqual({ status: 404, code: 'SESSION_NOT_FOUND', message: CALL_LINK_NOT_FOUND });
  });
});

describe('circles stay members-only (handed over by Task 3)', () => {
  it('admitToCircle writes a membership only for a member account, so no path can make an event guest a circle member', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'services/circle/circle.service.ts'), 'utf8');
    const admit = src.slice(src.indexOf('export async function admitToCircle'), src.indexOf('/** Whether the person who made an invite'));
    expect(admit).toMatch(/INSERT INTO circle_members \(circle_id, user_id\)\s+SELECT \$1, u\.id FROM users u WHERE u\.id = \$2 AND u\.account_kind = 'member'/);
    const waiting = src.slice(src.indexOf('async function admitEveryoneWaiting'), src.indexOf('/** Archive, never delete'));
    expect(waiting).toMatch(/AND u\.account_kind = 'member'/);
  });

  it('nothing on the Call link path touches a pod or a circle', () => {
    for (const file of ['call-link.service.ts', 'call-entry.service.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'services/session', file), 'utf8');
      expect(src).not.toMatch(/circle_members|pod_members|joinCircle|addMember|admitToCircle/);
    }
  });
});
