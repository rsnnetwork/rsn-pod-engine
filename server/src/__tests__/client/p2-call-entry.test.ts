// server/src/__tests__/client/p2-call-entry.test.ts
//
// The RSN Call entry flow and the guest home (Part 2 foundation, Task 12; spec 02, 04, 12/01-05; design-review prototype
// 1, "open speed networking entry without onboarding"). A signed-out visitor opens /call/<code>, sees the event, gives an
// email and the 6-digit code from it, gives only what that event needs, and goes straight in. An event guest is kept to
// their event and their guest home, never sent into platform onboarding, and never asks a member-only route.
//
// The pure rules run here (which screen, which fields, which words, where a guest may go); the components are run with
// loadClientModule where what they draw matters (the details step, the protected page); the wiring is pinned by source,
// as its neighbours in this folder do. The headed walk is e2e/tests/p2-call-link-entry.spec.ts.

import * as fs from 'fs';
import * as path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CALL_LINK_BASE_PATH, type CallEntryState, type CallLanding } from '@rsn/shared';
import { isGuestAllowed } from '../../middleware/guest-scope';
import { gateTarget, isGateExempt, onboardingDue } from '../../../../client/src/components/layout/onboarding-gate';
import {
  GUEST_HOME_PATH, callPathForEvent, guestAllowedPath, isEventGuest, memberIdOf, rememberCallLink,
} from '../../../../client/src/features/call/guest-routes';
import {
  ADMISSION_CODE_DID_NOT_WORK, CALL_API, CALL_WORDS, PROGRESS_STEPS, admissionCodeFailure, admissionRefusalOf, asksSentence, callScreenOf,
  detailsFieldsFor, durationLabel, emailFailure, enterFailure, progressIndexOf, refusalSentence, startsPhrase,
  tokenFailureMessage, verifyFailure, youreInSentence,
} from '../../../../client/src/features/call/call-entry';
import { iconStandIns, loadClientModule, readClientSource } from './load-client-module';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = readClientSource;

/** Every .ts/.tsx file under client/src (no tests, no declarations). */
const sourcesUnder = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .filter((e) => !e.name.startsWith('__test'))
  .flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourcesUnder(full);
    return /\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(e.name) ? [full] : [];
  });
const rel = (file: string) => path.relative(CLIENT, file).split(path.sep).join('/');

// Part 3 Task 5 added `questions` to both shapes (a required matching question unanswered; the questions asked).
const NOTHING = { displayName: false, group: false, admissionCode: false, questions: false };
const INVITATION_ONLY = 'This event is invitation only. Enter your admission code, or ask the organiser to invite this email address.';

const GROUPS = {
  question: 'Are you a founder or a funder?',
  multiple: false,
  options: [{ key: 'founder', label: 'Founder' }, { key: 'funder', label: 'Funder' }],
};

function landing(over: Partial<CallLanding> = {}): CallLanding {
  return {
    code: 'k7m2x9q4ra',
    title: 'Founders meet funders',
    description: null,
    scheduledAt: '2026-11-20T17:00:00.000Z',
    timezone: 'Europe/Copenhagen',
    imageUrl: null,
    durationMinutes: 60,
    format: 'speed_networking',
    host: { displayName: 'Stefan', avatarUrl: null },
    lifecycle: 'registration_open',
    admission: 'open',
    asks: { displayName: true, group: null, admissionCode: false, questions: null },
    viewer: { signedIn: false, accountKind: null, sessionId: null, step: 'identify' },
    ...over,
  };
}

function state(over: Partial<CallEntryState> = {}): CallEntryState {
  return {
    step: 'details', sessionId: null, livePath: null, missing: { ...NOTHING }, refusal: null,
    startsAt: '2026-11-20T17:00:00.000Z', waitlistPosition: null, ...over,
  };
}

// ─── Step 1 of the brief ──────────────────────────────────────────────────────

describe('the call route', () => {
  const app = read('App.tsx');

  it('is built from CALL_LINK_BASE_PATH and sits with the public pages, outside ProtectedRoute', () => {
    const line = app.split('\n').find((l) => l.includes('<CallLinkPage />')) ?? '';
    expect(line.trim()).toBe('<Route path={`${CALL_LINK_BASE_PATH}/:code`} element={<CallLinkPage />} />');
    expect(line).not.toMatch(/ProtectedRoute/);
    // Before the first protected group: a signed-out visitor is never asked to sign in first.
    expect(app.indexOf('<CallLinkPage />')).toBeGreaterThan(app.indexOf('{/* Public pages */}'));
    expect(app.indexOf('<CallLinkPage />')).toBeLessThan(app.indexOf('{/* Protected with layout */}'));
    expect(app).toMatch(/import \{ CALL_LINK_BASE_PATH, EVENT_LINK_BASE_PATH \} from '@rsn\/shared';/);
  });

  it('no client file writes the link path as a literal: the shared constant is the one place (Stefan to confirm the name)', () => {
    expect(CALL_LINK_BASE_PATH).toBe('/call');
    const literal = /['"`]\/call(?:['"`/?#]|\$\{)/;
    const found = sourcesUnder(CLIENT).filter((f) => literal.test(fs.readFileSync(f, 'utf8'))).map(rel);
    expect(found).toEqual([]);
  });

  it('the guest home /my-events is a protected page of the signed-in frame, named by its constant', () => {
    expect(GUEST_HOME_PATH).toBe('/my-events');
    const shellRoutes = app.slice(app.indexOf('<ReasonShell />'), app.indexOf('{/* Protected without layout'));
    expect(shellRoutes).toContain('<Route path={GUEST_HOME_PATH} element={<GuestHome />} />');
  });
});

describe('platform onboarding is never on the way in', () => {
  it('onboardingDue is null for an event guest, whatever their onboarding says', () => {
    expect(onboardingDue({ accountKind: 'event_guest', onboardingStatus: 'pending' })).toBeNull();
    expect(onboardingDue({ accountKind: 'event_guest', onboardingStatus: 'not_started', onboardingVersion: null })).toBeNull();
    expect(onboardingDue({ accountKind: 'event_guest', onboardingStatus: 'completed', onboardingVersion: 2, location: null })).toBeNull();
  });

  it('a member is gated exactly as before (the guest rule reads only accountKind)', () => {
    expect(onboardingDue({ accountKind: 'member', onboardingStatus: 'pending' })).toBe('flow');
    expect(onboardingDue({ onboardingStatus: 'not_started', onboardingVersion: null })).toBe('flow');
    expect(onboardingDue({ accountKind: 'member', onboardingStatus: 'completed', onboardingVersion: 2, location: 'Lisbon, Portugal' })).toBeNull();
  });

  it('the call link is exempt from the gate, and the gate never sends anyone to a call page', () => {
    expect(isGateExempt(`${CALL_LINK_BASE_PATH}/k7m2x9q4ra`)).toBe(true);
    expect(isGateExempt('/callx/abc')).toBe(false);
    expect(isGateExempt('/calls')).toBe(false);
    expect(gateTarget('flow', '/call/k7m2x9q4ra', '')).toBe('/onboarding?redirect=%2Fcall%2Fk7m2x9q4ra');
  });
});

describe('where an event guest may go', () => {
  it.each([
    ['/call/k7m2x9q4ra', true],
    ['/call/K7M2-X9Q4-RA', true],
    ['/session/0a1b2c3d-1111-2222-3333-444455556666/live', true],
    ['/my-events', true],
    ['/notifications', true],
    ['/settings', true],
    ['/request-to-join', true],
    ['/', false],
    ['/people/everyone', false],
    ['/connections', false],
    ['/search', false],
    ['/messages', false],
    ['/messages/new/abc', false],
    ['/pods', false],
    ['/circles', false],
    ['/entities', false],
    ['/sessions', false],
    ['/sessions/abc', false],
    ['/session/abc/host', false],
    ['/profile', false],
    ['/onboarding', false],
    ['/admin', false],
    ['/call', false],
    ['/call/a/b', false],
    ['/my-events/x', false],
    ['/settingsx', false],
  ])('%s → %s', (pathname, allowed) => {
    expect(guestAllowedPath(pathname)).toBe(allowed);
  });

  it('the kind comes from the session; a session that does not say is a member', () => {
    expect(isEventGuest({ id: 'g', accountKind: 'event_guest' })).toBe(true);
    expect(isEventGuest({ id: 'm', accountKind: 'member' })).toBe(false);
    expect(isEventGuest({ id: 'm' })).toBe(false);
    expect(isEventGuest(null)).toBe(false);
    expect(memberIdOf({ id: 'm', accountKind: 'member' })).toBe('m');
    expect(memberIdOf({ id: 'm' })).toBe('m');
    expect(memberIdOf({ id: 'g', accountKind: 'event_guest' })).toBeUndefined();
    expect(memberIdOf(undefined)).toBeUndefined();
  });

  it('the way back to an event\'s link is kept per event, newest first, and only for a code-shaped value', () => {
    const store = new Map<string, string>();
    const g = global as unknown as { localStorage?: unknown };
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
    try {
      expect(callPathForEvent('s1')).toBeNull();
      rememberCallLink('s1', 'k7m2x9q4ra');
      rememberCallLink('s2', 'zzzzzzzzzz');
      rememberCallLink('s1', 'abcdefghjk');
      rememberCallLink('s3', '"/><script>');
      expect(callPathForEvent('s1')).toBe(`${CALL_LINK_BASE_PATH}/abcdefghjk`);
      expect(callPathForEvent('s2')).toBe(`${CALL_LINK_BASE_PATH}/zzzzzzzzzz`);
      expect(callPathForEvent('s3')).toBeNull();
      for (let i = 0; i < 30; i += 1) rememberCallLink(`x${i}`, 'k7m2x9q4ra');
      expect(JSON.parse(store.get('rsn_call_links')!)).toHaveLength(20);
      store.set('rsn_call_links', 'not json');
      expect(callPathForEvent('s1')).toBeNull();
    } finally {
      delete g.localStorage;
    }
  });
});

describe('the protected page confines a guest before the onboarding gate', () => {
  function render(user: Record<string, unknown>, pathname: string): string {
    const full = { user, isLoading: false, sessionRetrying: false };
    const mod = loadClientModule('components/layout/ProtectedRoute.tsx', {
      '@/stores/authStore': { useAuthStore: (pick?: (s: unknown) => unknown) => (pick ? pick(full) : full) },
      'react-router-dom': {
        Navigate: ({ to }: { to: string }) => createElement('a', { 'data-navigate': to }),
        useLocation: () => ({ pathname, search: '' }),
      },
      '@/components/ui/Spinner': { PageLoader: () => createElement('span', { 'data-loader': '' }) },
    });
    return renderToStaticMarkup(createElement(mod.default as never, null, createElement('main', null, 'page')));
  }
  const guest = { id: 'g1', accountKind: 'event_guest', onboardingStatus: 'not_started', onboardingVersion: null };
  const member = { id: 'm1', accountKind: 'member', onboardingStatus: 'not_started', onboardingVersion: null };

  it('a guest on a member page (Everyone, For You, Messages, Pods, Circles) goes to the guest home, never to onboarding', () => {
    for (const p of ['/people/everyone', '/', '/messages', '/pods', '/circles', '/sessions/abc']) {
      expect(render(guest, p)).toBe('<a data-navigate="/my-events"></a>');
    }
  });

  it('a guest reaches their live room, the guest home, their bell and settings, with no onboarding in between', () => {
    for (const p of ['/session/s-1/live', '/my-events', '/notifications', '/settings']) {
      expect(render(guest, p)).toBe('<main>page</main>');
    }
  });

  it('a member who has not onboarded is still gated as before', () => {
    expect(render(member, '/people/everyone')).toBe('<a data-navigate="/onboarding?redirect=%2Fpeople%2Feveryone"></a>');
    expect(render(member, '/session/s-1/live')).toBe('<main>page</main>');
  });

  it('the guest check comes before the gate in the source too', () => {
    const src = read('components/layout/ProtectedRoute.tsx');
    expect(src.indexOf('isEventGuest(user)')).toBeGreaterThan(src.indexOf('if (!user) return'));
    expect(src.indexOf('isEventGuest(user)')).toBeLessThan(src.indexOf('const due = onboardingDue(user);'));
  });
});

describe('no page of the flow asks a member-only route', () => {
  const ID = '0a1b2c3d-1111-2222-3333-444455556666';
  const CALLS: Array<[string, string]> = [
    ['GET', CALL_API.landing('k7m2x9q4ra')],
    ['POST', CALL_API.email('k7m2x9q4ra')],
    ['POST', CALL_API.verify('k7m2x9q4ra')],
    ['GET', CALL_API.entry('k7m2x9q4ra')],
    ['POST', CALL_API.enter('k7m2x9q4ra')],
    ['GET', CALL_API.myEvents()],
    ['GET', CALL_API.mySchedule(ID)],
  ];

  it.each(CALLS)('%s /api%s is on the guest allowlist', (method, p) => {
    expect(isGuestAllowed(method, `/api${p}`)).toBe(true);
  });

  it('every request in features/call goes through CALL_API (no other path is written there)', () => {
    // Part 3 Task 8: leaving a full event's waiting list is a DELETE, through CALL_API.leaveWaitlist like the rest.
    const files = sourcesUnder(path.join(CLIENT, 'features/call'));
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const calls = src.match(/api\.(?:get|post|put|patch|delete)\(\s*[^,)]*/g) ?? [];
      for (const call of calls) expect({ file: rel(file), call }).toEqual({ file: rel(file), call: expect.stringMatching(/api\.(get|post|delete)\(CALL_API\.\w+\(/) });
    }
  });

  it('the app-wide member reads (Messages badge, group chats, calls) are off for a guest', () => {
    expect(read('features/messages/useMessagesUnread.ts')).toMatch(/const userId = useAuthStore\(\(s\) => memberIdOf\(s\.user\)\);/);
    expect(read('features/messages/useGroups.ts')).toMatch(/const useMe = \(\) => useAuthStore\(\(s\) => memberIdOf\(s\.user\)\);/);
    expect(read('features/calls/useCallSignals.ts')).toMatch(/const me = useAuthStore\(\(s\) => memberIdOf\(s\.user\)\);/);
  });

  it('a guest gets the guest frame, which has no member navigation and no tour', () => {
    const shell = read('features/reason/shell/ReasonShell.tsx');
    expect(shell).toMatch(/const guest = useAuthStore\(\(s\) => isEventGuest\(s\.user\)\);\s*return guest \? <GuestShell \/> : <MemberShell \/>;/);
    const guestShell = read('features/call/GuestShell.tsx');
    expect(guestShell).not.toMatch(/ShellSidebar|MobileNav|OnboardingTour|useMessagesUnread|PeopleTabs|\/people|\/messages|\/pods|\/circles/);
    expect(guestShell).toMatch(/<NotificationBell \/>/);
    expect(guestShell).toMatch(/to="\/settings"/);
    expect(guestShell).toMatch(/safe-area-inset-top/);
  });
});

// ─── The details step: only what is missing ───────────────────────────────────

describe('the details step renders only the fields flagged in missing', () => {
  function draw(missing: CallEntryState['missing'], ask: typeof GROUPS | null = GROUPS, refusal: string | null = null): string {
    const mod = loadClientModule('features/call/CallDetailsStep.tsx', { 'lucide-react': iconStandIns });
    return renderToStaticMarkup(createElement(mod.default as never, {
      fields: detailsFieldsFor(missing, ask),
      refusal,
      approval: false,
      defaults: { admissionCode: '' },
      submit: async () => undefined,
      onClosed: () => undefined,
    }));
  }
  const has = (html: string) => ({
    name: html.includes('>Your name</label>'),
    group: html.includes('Are you a founder or a funder?'),
    code: html.includes('>Admission code</label>'),
  });

  it.each([
    [{ displayName: true, group: false, admissionCode: false, questions: false }, { name: true, group: false, code: false }],
    [{ displayName: false, group: true, admissionCode: false, questions: false }, { name: false, group: true, code: false }],
    [{ displayName: false, group: false, admissionCode: true, questions: false }, { name: false, group: false, code: true }],
    [{ displayName: true, group: true, admissionCode: true, questions: false }, { name: true, group: true, code: true }],
    [{ displayName: false, group: false, admissionCode: false, questions: false }, { name: false, group: false, code: false }],
  ])('missing %j draws %j', (missing, expected) => {
    expect(has(draw(missing))).toEqual(expected);
  });

  it('a group flagged without a question to ask is not drawn (nothing to choose from)', () => {
    expect(detailsFieldsFor({ ...NOTHING, group: true }, null).group).toBeNull();
    expect(detailsFieldsFor({ ...NOTHING, group: true }, { ...GROUPS, options: [] }).group).toBeNull();
    expect(detailsFieldsFor({ ...NOTHING, group: false }, GROUPS).group).toBeNull();
  });

  it('the group question is large tiles: one radio each for a single group, a checkbox each where several are allowed', () => {
    const one = draw({ ...NOTHING, group: true });
    expect(one.match(/type="radio"/g)).toHaveLength(2);
    expect(one).toContain('Founder');
    expect(one).toContain('Funder');
    expect(one).toMatch(/<label class="[^"]*min-h-\[56px\]/);
    const many = draw({ ...NOTHING, group: true }, { ...GROUPS, multiple: true });
    expect(many.match(/type="checkbox"/g)).toHaveLength(2);
    expect(many).toContain('Choose all that apply.');
  });

  it('an invitation-only refusal is said above the admission code, in the event\'s own words', () => {
    const html = draw({ ...NOTHING, admissionCode: true }, null, 'This event is for invited guests. Enter the email you were invited with, or an admission code.');
    expect(html).toContain('data-testid="call-refusal"');
    expect(html).toContain('This event is for invited guests.');
    expect(html.indexOf('call-refusal')).toBeLessThan(html.indexOf('>Admission code</label>'));
  });
});

// ─── Which screen ─────────────────────────────────────────────────────────────

describe('which screen a person is on', () => {
  it('signed out: the event, then the email, then the code; an ended or cancelled event says so instead', () => {
    expect(callScreenOf({ landing: landing(), entry: null, phase: 'summary', started: false })).toBe('summary');
    expect(callScreenOf({ landing: landing(), entry: null, phase: 'email', started: false })).toBe('email');
    expect(callScreenOf({ landing: landing(), entry: null, phase: 'code', started: false })).toBe('code');
    expect(callScreenOf({ landing: landing({ lifecycle: 'cancelled' }), entry: null, phase: 'email', started: false })).toBe('cancelled');
    expect(callScreenOf({ landing: landing({ lifecycle: 'completed' }), entry: null, phase: 'summary', started: false })).toBe('ended');
    expect(callScreenOf({ landing: landing({ lifecycle: 'archived' }), entry: null, phase: 'code', started: false })).toBe('ended');
  });

  it('signed in: the event and a button first, then only what is missing, or straight in when nothing is', () => {
    const l = landing({ viewer: { signedIn: true, accountKind: 'member', sessionId: null, step: 'details' } });
    expect(callScreenOf({ landing: l, entry: state(), phase: 'summary', started: false })).toBe('summary');
    expect(callScreenOf({ landing: l, entry: state(), phase: 'summary', started: true })).toBe('joining');
    expect(callScreenOf({ landing: l, entry: state({ missing: { ...NOTHING, displayName: true } }), phase: 'summary', started: true })).toBe('details');
    expect(callScreenOf({ landing: l, entry: state({ step: 'request' }), phase: 'summary', started: true })).toBe('joining');
  });

  it('every answer the server gives has its screen, whatever was pressed', () => {
    const l = landing();
    const at = (step: CallEntryState['step']) => callScreenOf({ landing: l, entry: state({ step }), phase: 'summary', started: false });
    expect(at('enter')).toBe('live');
    expect(at('wait_for_start')).toBe('waiting');
    expect(at('pending_approval')).toBe('pending');
    expect(at('declined')).toBe('declined');
    expect(at('refused')).toBe('refused');
    expect(at('ended')).toBe('ended');
    expect(at('cancelled')).toBe('cancelled');
  });

  it('the progress dots read "Open link · Identify · Check · Join event" (Stefan, 11 Nov: it is an event, not a call)', () => {
    expect([...PROGRESS_STEPS]).toEqual(['Open link', 'Identify', 'Check', 'Join event']);
    expect(['summary', 'email', 'code', 'details', 'joining', 'waiting', 'pending'].map((s) => progressIndexOf(s as never)))
      .toEqual([0, 1, 1, 2, 2, 3, 3]);
  });
});

// ─── The words ────────────────────────────────────────────────────────────────

describe('what the flow says', () => {
  it('"This event will ask for: …" lists only what this event asks', () => {
    expect(asksSentence({ displayName: true, group: null, admissionCode: false, questions: null }, false)).toBe('This event will ask for: your email, your name');
    expect(asksSentence({ displayName: true, group: GROUPS, admissionCode: false, questions: null }, false)).toBe('This event will ask for: your email, your name, your group');
    expect(asksSentence({ displayName: true, group: GROUPS, admissionCode: true, questions: null }, false))
      .toBe('This event will ask for: your email, your name, your group, an admission code');
    expect(asksSentence({ displayName: false, group: null, admissionCode: false, questions: null }, true)).toBeNull();
    expect(asksSentence({ displayName: false, group: GROUPS, admissionCode: false, questions: null }, true)).toBe('This event will ask for: your group');
  });

  it('the fixed sentences, verbatim', () => {
    expect(CALL_WORDS.checkInbox).toBe('Check your inbox for a 6-digit code');
    expect(CALL_WORDS.sendCode).toBe('Send me a code');
    expect(CALL_WORDS.admissionCodeLabel).toBe('Admission code (if you have one)');
    expect(CALL_WORDS.ended).toBe('This event has ended.');
    expect(CALL_WORDS.cancelled).toBe('This event was cancelled.');
    expect(CALL_WORDS.pending).toBe('Waiting for the organiser to approve you');
    // The brief's "Become an RSN member": the product is called REASON on every screen (reason-wording.test.ts).
    expect(CALL_WORDS.becomeMember).toBe('Become a REASON member: meet people beyond this event.');
  });

  it('"You\'re in. {title} starts {when}." on the event\'s clock with its zone named (Part 3), or as soon as the organiser opens it', () => {
    const now = Date.parse('2026-11-11T10:00:00Z');
    expect(youreInSentence('Founders meet funders', '2026-11-20T17:00:00.000Z', 'Europe/Copenhagen', now))
      .toBe("You're in. Founders meet funders starts on Friday 20 November at 18:00 CET.");
    expect(startsPhrase('2026-11-20T17:00:00.000Z', now, 'Europe/Copenhagen')).toBe('on Friday 20 November at 18:00 CET');
    expect(startsPhrase(null, now)).toBe('as soon as the organiser opens it');
    expect(startsPhrase('2026-11-01T10:00:00Z', now)).toBe('as soon as the organiser opens it');
    expect(durationLabel(60)).toBe('1 hour');
    expect(durationLabel(90)).toBe('1 hour 30 minutes');
    expect(durationLabel(40)).toBe('40 minutes');
  });

  const fail = (status: number, code: string, message = 'server words', details?: object) =>
    ({ response: { status, data: { error: { code, message, details } } } });

  it('asking for the code: only the event or a limit can fail it (every address gets the same answer); never a code', () => {
    expect(emailFailure(fail(409, 'EVENT_ENDED'))).toMatchObject({ closed: 'ended' });
    expect(emailFailure(fail(409, 'EVENT_CANCELLED'))).toMatchObject({ closed: 'cancelled' });
    expect(emailFailure(fail(404, 'SESSION_NOT_FOUND'))).toMatchObject({ closed: 'not_found' });
    expect(emailFailure(fail(400, 'VALIDATION_ERROR'))).toEqual({ field: 'email', message: 'Enter a valid email address.' });
    expect(emailFailure(fail(503, 'SERVICE_UNAVAILABLE', 'We cannot send codes for this event just now. Please try again later.')))
      .toEqual({ field: null, message: 'We cannot send codes for this event just now. Please try again later.' });
    expect(emailFailure(fail(429, 'RATE_LIMITED')).message).toBe('Too many tries. Please wait a few minutes, then try again.');
    expect(emailFailure(fail(500, 'INTERNAL_ERROR', 'relation "x" does not exist')).message).toBe('We could not send the code. Please try again.');
    expect(emailFailure({ request: {}, code: 'ERR_NETWORK' }).message).toBe('Connection lost. Check your internet and try again.');
  });

  it('checking the code: the server\'s tries left, a lock, an over event', () => {
    expect(verifyFailure(fail(400, 'AUTH_SIGN_IN_CODE_WRONG', 'x', { attemptsLeft: 3 })))
      .toEqual({ field: 'code', message: 'That code is not right. You can try 3 more times.' });
    expect(verifyFailure(fail(400, 'AUTH_SIGN_IN_LOCKED')).message).toMatch(/^That code was entered wrongly too many times/);
    expect(verifyFailure(fail(409, 'EVENT_CANCELLED'))).toMatchObject({ closed: 'cancelled' });
    expect(verifyFailure(fail(429, 'RATE_LIMIT_EXCEEDED')).message).toBe('Too many codes tried. Please wait 15 minutes, then try again.');
  });

  it('after a right code, the event\'s refusal of the address is told apart from a wrong code, with whether a code helps', () => {
    expect(admissionRefusalOf(fail(403, 'EVENT_ADMISSION_REQUIRED', INVITATION_ONLY, { admissionCode: true })))
      .toEqual({ message: INVITATION_ONLY, askCode: true });
    expect(admissionRefusalOf(fail(403, 'EVENT_PRIVATE', 'This event is for REASON members and the people its organiser invites. Ask the organiser for an invitation.', { admissionCode: false })))
      .toEqual({ message: 'This event is for REASON members and the people its organiser invites. Ask the organiser for an invitation.', askCode: false });
    // No details: an invitation-only refusal still offers the field.
    expect(admissionRefusalOf(fail(403, 'EVENT_ADMISSION_REQUIRED', INVITATION_ONLY))?.askCode).toBe(true);
    expect(admissionRefusalOf(fail(400, 'AUTH_SIGN_IN_CODE_WRONG', 'x', { attemptsLeft: 2 }))).toBeNull();
    expect(admissionRefusalOf(fail(403, 'ACCOUNT_CLOSED'))).toBeNull();
    expect(admissionRefusalOf(new Error('Network Error'))).toBeNull();
    expect(ADMISSION_CODE_DID_NOT_WORK).toBe("That admission code didn't let you in. Check it, or ask the organiser.");
  });

  it('the email\'s button that no longer works asks for the email again; a closed account says so', () => {
    expect(tokenFailureMessage(fail(400, 'AUTH_MAGIC_LINK_EXPIRED'))).toBe(CALL_WORDS.linkExpired);
    expect(tokenFailureMessage(fail(400, 'AUTH_MAGIC_LINK_USED'))).toBe(CALL_WORDS.linkExpired);
    expect(tokenFailureMessage(fail(403, 'ACCOUNT_CLOSED'))).toMatch(/^This account was closed\./);
    expect(verifyFailure(fail(403, 'ACCOUNT_CLOSED')).message).toMatch(/^This account was closed\./);
  });

  it('entering: an admission code\'s own sentence beside the code ("already been used"), a name beside the name', () => {
    expect(enterFailure(fail(409, 'ADMISSION_CODE_USED', 'This admission code has already been used.')))
      .toEqual({ field: 'admissionCode', message: 'This admission code has already been used.' });
    expect(enterFailure(fail(400, 'ADMISSION_CODE_INVALID', 'That admission code is not right.')).field).toBe('admissionCode');
    expect(enterFailure(fail(400, 'VALIDATION_ERROR', 'Enter your name (up to 60 characters).')))
      .toEqual({ field: 'displayName', message: 'Enter your name (up to 60 characters).' });
    expect(enterFailure(fail(429, 'RATE_LIMITED')).field).toBe('admissionCode');
    // A server sentence carrying an id is never shown.
    expect(enterFailure(fail(403, 'X', 'User 0a1b2c3d-1111-2222-3333-444455556666 refused')).message).toBe(CALL_WORDS.joinFailed);
  });

  it('a refusal is the event\'s own sentence, or a plain one', () => {
    expect(refusalSentence(state({ step: 'refused', refusal: { code: 'REMOVED_FROM_EVENT', message: 'You have been removed from this event by the host' } })))
      .toBe('You have been removed from this event by the host');
    expect(refusalSentence(state({ step: 'refused', refusal: null }))).toBe('This event is not open to you.');
  });
});

// ─── The wiring ───────────────────────────────────────────────────────────────

describe('the wiring', () => {
  it('the code step is the sign-in page\'s code entry, as six boxes over one one-time-code field', () => {
    const step = read('features/call/CallCodeStep.tsx');
    expect(step).toMatch(/import SignInCodeEntry from '@\/features\/auth\/SignInCodeEntry';/);
    expect(step).toMatch(/<SignInCodeEntry[\s\S]*?\bboxes\b[\s\S]*?verify=\{check\}/);
    expect(step).toMatch(/const RESEND_WAIT_SECONDS = 30;/);
    expect(step).toMatch(/`Resend in \$\{wait\}s`/);
    const entry = read('features/auth/SignInCodeEntry.tsx');
    const boxes = entry.slice(entry.indexOf('data-testid="code-boxes"'), entry.indexOf(') : ('));
    expect(boxes).toMatch(/autoComplete="one-time-code"/);
    expect(boxes).toMatch(/inputMode="numeric"/);
    // Each box is 56px tall and at least 44px wide; the field over them is 16px so iOS does not zoom.
    expect(boxes).toMatch(/'flex h-14 min-w-\[44px\]/);
    expect(boxes).toMatch(/text-\[16px\] text-transparent/);
  });

  it('the email answer always moves on to "Check your inbox"; the admission code waits on the page for /verify', () => {
    const page = read('features/call/CallLinkPage.tsx');
    expect(page).toMatch(/const sent = await sendCode\.mutateAsync\(input\);[\s\S]*?setPhase\('code'\);/);
    expect(read('features/call/CallCodeStep.tsx')).toMatch(/\{proved \? 'Your email is confirmed' : CALL_WORDS\.checkInbox\}/);
    const hook = read('features/call/useCallLink.ts');
    const send = hook.slice(hook.indexOf('const sendCode = useMutation'), hook.indexOf('const verify = useMutation'));
    expect(send).not.toMatch(/admissionCode:/);
    // The same 6-digit code goes again with the admission code; the email's button likewise.
    expect(page).toMatch(/\{ token: tokenRefused\.token, \.\.\.extra \}/);
    expect(page).toMatch(/\{ email, code: typed \?\? '', \.\.\.extra \}/);
  });

  it('an admission code given on the page is not asked for again: it goes with the entry, and only a refusal of it shows the field', () => {
    const page = read('features/call/CallLinkPage.tsx');
    expect(page).toMatch(/const carryCode = !!raw && !!carried && raw\.missing\.admissionCode;/);
    expect(page).toMatch(/missing: \{ \.\.\.raw\.missing, admissionCode: false \}, refusal: null/);
    expect(page).toMatch(/enter\.mutateAsync\(carryCode \? \{ admissionCode: carried \} : \{\}\)/);
    expect(page).toMatch(/if \(said\.field === 'admissionCode' && carryCode\) dropCarried\(said\.message\);/);
    expect(page).toMatch(/if \(admission\) setAdmissionCode\(admission\);\s*setStarted\(true\);/);
  });

  it('a used admission code at /verify (409 ADMISSION_CODE_USED) says the brief\'s sentence beside the field, on either way in', () => {
    const used = { response: { status: 409, data: { error: { code: 'ADMISSION_CODE_USED', message: 'This admission code has already been used.' } } } };
    expect(admissionRefusalOf(used)).toBeNull();
    expect(admissionCodeFailure(used)).toBe('This admission code has already been used.');
    const step = read('features/call/CallCodeStep.tsx');
    // The code sent with an admission code from the email step: the code step turns to the admission step with the sentence.
    expect(step).toMatch(/const usedCode = admissionCodeFailure\(err\);\s*if \(usedCode\) \{\s*setProved\(\{ code, refusal: \{ message: usedCode, askCode: true \} \}\);\s*return;/);
    // An admission code typed on the admission step: the sentence beside the field.
    expect(step).toMatch(/const usedCode = admissionCodeFailure\(err\);\s*if \(usedCode\) \{\s*setError\(usedCode\);\s*return;/);
    // Never through enterFailure, which puts every 429 beside the admission code.
    expect(step).not.toMatch(/enterFailure/);
    expect(read('../../e2e/tests/p2-call-link-entry.spec.ts'))
      .toContain("second.getByText('This admission code has already been used.', { exact: true })");
  });

  it('a 429 or a wrong 6-digit code at /verify stays on the code boxes: only an admission code\'s own answer turns the step', () => {
    const fail = (status: number, code: string, message = 'x', details?: object) => ({ response: { status, data: { error: { code, message, details } } } });
    for (const err of [
      fail(429, 'RATE_LIMIT_EXCEEDED', 'Too many codes tried. Please wait 15 minutes, then try again.'),
      fail(429, 'RATE_LIMITED'),
      fail(400, 'AUTH_SIGN_IN_CODE_WRONG', 'x', { attemptsLeft: 2 }),
      fail(400, 'AUTH_SIGN_IN_LOCKED'),
      fail(400, 'AUTH_SIGN_IN_CODE_EXPIRED'),
    ]) {
      expect(admissionCodeFailure(err)).toBeNull();
      expect(admissionRefusalOf(err)).toBeNull();
      expect(verifyFailure(err).field).toBe('code');
    }
    expect(verifyFailure(fail(429, 'RATE_LIMIT_EXCEEDED')).message).toBe('Too many codes tried. Please wait 15 minutes, then try again.');
    expect(admissionCodeFailure(fail(400, 'ADMISSION_CODE_EXPIRED', 'This admission code has expired.'))).toBe('This admission code has expired.');
    expect(admissionCodeFailure(fail(400, 'ADMISSION_CODE_INVALID', ''))).toBe('That admission code is not right.');
  });

  it('the live page asks no member route for a guest: its own register call is not made for one', () => {
    const hook = read('hooks/useSessionSocket.ts');
    expect(hook).toMatch(/\(isEventGuest\(useAuthStore\.getState\(\)\.user\) \? Promise\.resolve\(\) : api\.post\(`\/sessions\/\$\{sessionId\}\/register`\)\)\.catch\(err => \{/);
    expect(hook).toMatch(/import \{ isEventGuest \} from '@\/features\/call\/guest-routes';/);
  });

  it('after a right code, a refused address stays on the code step and is asked for the admission code', () => {
    const step = read('features/call/CallCodeStep.tsx');
    expect(step).toMatch(/const refusal = admissionRefusalOf\(err\);\s*if \(refusal\) \{\s*setProved\(\{ code, refusal \}\);\s*return;/);
    expect(step).toMatch(/await verify\(proved\.code, admissionCode\.trim\(\)\);/);
    const draw = (refusal: { message: string; askCode: boolean }) => {
      const mod = loadClientModule('features/call/CallCodeStep.tsx', {
        'lucide-react': iconStandIns,
        '@/features/auth/SignInCodeEntry': { __esModule: true, default: () => createElement('div', { 'data-code-entry': '' }) },
      });
      return renderToStaticMarkup(createElement(mod.default as never, {
        email: null, devCode: null, verify: async () => undefined, carriedAdmissionCode: '', initialRefusal: refusal,
        resend: async () => undefined, onDifferentEmail: () => undefined, onClosed: () => undefined,
      }));
    };
    const invited = draw({ message: INVITATION_ONLY, askCode: true });
    expect(invited).toContain(INVITATION_ONLY);
    expect(invited).toContain('>Admission code</label>');
    expect(invited).not.toContain('data-code-entry');
    const members = draw({ message: 'This event is for REASON members.', askCode: false });
    expect(members).toContain('This event is for REASON members.');
    expect(members).not.toContain('>Admission code</label>');
    expect(members).toContain('Use a different email');
  });

  it('a signed-in member skips the email and the code; the email\'s button (?entry=) verifies by itself and leaves the address bar', () => {
    const page = read('features/call/CallLinkPage.tsx');
    // Part 3 Task 8: the Join press is joinAgain(), which starts (setStarted(true)) and re-arms the automatic enter.
    expect(page).toMatch(/onClick=\{\(\) => \(userId \? (setStarted\(true\)|joinAgain\(\)) : setPhase\('email'\)\)\}/);
    expect(page).toMatch(/const joinAgain = \(\) => \{\s*setAutoTried\(false\);\s*setStarted\(true\);\s*\};/);
    expect(page).toMatch(/const entryToken = params\.get\('entry'\);/);
    expect(page).toMatch(/rest\.delete\('entry'\);\s*setParams\(rest, \{ replace: true \}\);\s*setTokenPending\(true\);\s*verify\.mutateAsync\(\{ token: entryToken \}\)/);
  });

  it('in: straight to the live room, writing down the link that led there', () => {
    const page = read('features/call/CallLinkPage.tsx');
    expect(page).toMatch(/if \(state\?\.sessionId\) rememberCallLink\(state\.sessionId, code\);\s*navigate\(livePath, \{ replace: true, state: FROM_CALL_LINK \}\);/);
  });

  it('a guest the live room refuses goes back to the event\'s call page; "back" is the guest home', () => {
    const guard = read('features/live/SessionGuard.tsx');
    expect(guard).toMatch(/const callPath = guest && !fromCallLink \? callPathForEvent\(sessionId\) : null;\s*if \(callPath\) return <Navigate to=\{callPath\} replace \/>;/);
    // Sent from the call page, a refusal is shown there and then: the two pages never bounce a person between them.
    expect(guard).toMatch(/const fromCallLink = \(useLocation\(\)\.state as \{ fromCallLink\?: boolean \} \| null\)\?\.fromCallLink === true;/);
    expect(guard).toMatch(/const eventsPath = guest \? GUEST_HOME_PATH : '\/sessions';/);
    expect(guard).not.toMatch(/navigate\('\/sessions'\)/);
  });

  it('the guest home lists the events by link (tagged user:<id>:sessions) and offers membership with the known address', () => {
    expect(read('features/call/useCallLink.ts')).toMatch(/queryKey: \['call-my-events', userId\],[\s\S]*?meta: \{ entities: userId \? \[E\.userSessions\(userId\)\] : \[\] \}/);
    const home = read('features/call/GuestHome.tsx');
    expect(home).toMatch(/`\/request-to-join\?email=\$\{encodeURIComponent\(email\)\}`/);
    expect(home).toMatch(/\{guest && <BecomeMember email=\{user\?\.email\} \/>\}/);
    // The event link (11 Nov 2026) first; the call link for an answer from an older server.
    expect(home).toMatch(/navigate\(event\.linkPath \?\? callLinkPath\(event\.code\)\)/);
    expect(read('features/auth/RequestToJoinPage.tsx')).toMatch(/const knownEmail = \(params\.get\('email'\) \?\? ''\)\.trim\(\)\.slice\(0, 255\);/);
  });

  it('every tap target of the flow is at least 44px', () => {
    for (const file of ['CallLinkPage.tsx', 'CallEmailStep.tsx', 'CallCodeStep.tsx', 'CallDetailsStep.tsx', 'CallWaitingStep.tsx', 'GuestShell.tsx', 'GuestHome.tsx']) {
      const src = read(`features/call/${file}`);
      // Each <button>'s own class list (its first className). The shared Button component is 44px at size "md" and 48px at
      // "lg", the only sizes used here.
      const classes = [...src.matchAll(/<button\b[\s\S]*?className=(\{ICON_BUTTON\}|"[^"]*")/g)].map((m) => m[1]);
      expect(classes.length).toBe((src.match(/<button\b/g) ?? []).length);
      for (const c of classes) expect({ file, c, ok: /min-h-\[44px\]|ICON_BUTTON/.test(c) }).toMatchObject({ ok: true });
      expect(src).not.toMatch(/<Button[^>]*size="sm"/);
    }
  });
});
