// server/src/__tests__/client/p3-event-links.test.ts
//
// The event link on the preview (Stefan, 11 Nov 2026): /events/<name>-<n>[-<tail>] opens the same entry as the call
// link; the organiser chooses the name on Schedule an Event and Edit Event with the link shown as they type; the card
// shows the event link with Copy; the words say "event link", never "call link". The pure rules run here; the wiring is
// pinned by source, as its neighbours in this folder do. The headed walk is e2e/tests/p3-event-links-ui.spec.ts.

import * as fs from 'fs';
import * as path from 'path';
import { EVENT_LINK_BASE_PATH, EVENT_LINK_NAME_RULE } from '@rsn/shared';
import { isGateExempt } from '../../../../client/src/components/layout/onboarding-gate';
import { callPathForEvent, guestAllowedPath, rememberCallLink, strongerKey } from '../../../../client/src/features/call/guest-routes';
import {
  editEventValues, eventBody, eventChanges, eventProblems, linkNameProblem, newEventValues, problemSummary, shownEventKeys,
} from '../../../../client/src/features/sessions/event-format-form';
import { historySentence } from '../../../../client/src/features/sessions/history/history-text';
import { readClientSource } from './load-client-module';

const read = readClientSource;
const CLIENT = path.join(__dirname, '../../../../client/src');

describe('the route, the onboarding gate and a guest\'s reach', () => {
  it('/events/:code renders the call link page, as /call/:code does', () => {
    const app = read('App.tsx');
    expect(EVENT_LINK_BASE_PATH).toBe('/events');
    expect(app).toContain('<Route path={`${EVENT_LINK_BASE_PATH}/:code`} element={<CallLinkPage />} />');
    expect(app).toContain('<Route path={`${CALL_LINK_BASE_PATH}/:code`} element={<CallLinkPage />} />');
  });

  it.each([
    ['/events/rsn-3', true], ['/events/rsn-3-k7m2q9', true], ['/events/rsn-3/', true], ['/events', false], ['/events/a/b', false],
  ])('a guest may open %s: %s; the gate never sends an event link to onboarding', (pathname, allowed) => {
    expect(guestAllowedPath(pathname)).toBe(allowed);
    if (allowed) expect(isGateExempt(pathname)).toBe(true);
  });

  it('the way back keeps an event link as an event link and a code as a call link, and nothing else', () => {
    const store = new Map<string, string>();
    const g = global as unknown as { localStorage?: unknown };
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    try {
      rememberCallLink('s1', 'rsn-3-k7m2q9');
      rememberCallLink('s2', 'k7m2x9q4ra');
      rememberCallLink('s3', 'rsn-3/../x');
      rememberCallLink('s4', 'RSN-3');
      expect(callPathForEvent('s1')).toBe('/events/rsn-3-k7m2q9');
      expect(callPathForEvent('s2')).toBe('/call/k7m2x9q4ra');
      expect(callPathForEvent('s3')).toBeNull();
      expect(callPathForEvent('s4')).toBeNull();
      // A tailed way back is never replaced by an untailed one for the same event (review minor, 12 Nov 2026).
      rememberCallLink('s1', 'rsn-3');
      expect(callPathForEvent('s1')).toBe('/events/rsn-3-k7m2q9');
      rememberCallLink('s1', 'founders-1-abcdef');
      expect(callPathForEvent('s1')).toBe('/events/founders-1-abcdef');
      // But the event's current link (the server says so) always replaces it: a held tail may be dead (rotated), and
      // the event's own link is the one that works now (rereview minor 4).
      rememberCallLink('s1', 'founders-1', { current: true });
      expect(callPathForEvent('s1')).toBe('/events/founders-1');
      // A long name with many hyphens is still remembered.
      const long = `${'ab-'.repeat(13)}x-12-k7m2q9`;
      rememberCallLink('s5', long);
      expect(callPathForEvent('s5')).toBe(`/events/${long}`);
    } finally {
      delete g.localStorage;
    }
  });

  it('the way back and the address bar never get a weaker link than the one held', () => {
    // The event's own link carries a tail: it wins (a code, a bare or an old link all become it).
    expect(strongerKey('k7m2x9q4ra', 'rsn-3-k7m2q9')).toBe('rsn-3-k7m2q9');
    expect(strongerKey('rsn-3', 'rsn-3-k7m2q9')).toBe('rsn-3-k7m2q9');
    // They came by a tailed link and the event's own is untailed now (it turned public): they keep theirs.
    expect(strongerKey('rsn-3-k7m2q9', 'rsn-3')).toBe('rsn-3-k7m2q9');
    // Nothing tailed either way: the event's own link, else what they came by.
    expect(strongerKey('k7m2x9q4ra', 'rsn-3')).toBe('rsn-3');
    expect(strongerKey('k7m2x9q4ra', null)).toBe('k7m2x9q4ra');
  });
});

describe('the entry page puts the event link as it is now in the address bar', () => {
  const page = read('features/call/CallLinkPage.tsx');

  it('from the landing\'s link, in place, only before anything is asked and never while the email\'s button is read', () => {
    expect(page).toContain('const wayBack = strongerKey(code, landing.data?.link?.slug);');
    expect(page).toContain('const linkPath = landing.data?.link && wayBack === landing.data.link.slug ? landing.data.link.path : null;');
    // Both ways back write the stronger key, never the URL's as typed.
    expect(page).not.toMatch(/rememberCallLink\([^)]*, code\)/);
    expect((page.match(/rememberCallLink\(\w+(?:\.\w+)?(?:!)?, wayBack, \{ current: wayIsCurrent \}\)/g) ?? []).length).toBe(2);
    expect(page).toContain('const wayIsCurrent = !!landing.data?.link && wayBack === landing.data.link.slug;');
    expect(page).toContain("if (entryToken || tokenPending || phase !== 'summary' || started) return;");
    expect(page).toContain('navigate(`${linkPath}${location.search}${location.hash}`, { replace: true });');
    // Declared with the page's other effects, before the first early return (hooks run in the same order every time).
    expect(page.indexOf('const linkPath = landing.data?.link')).toBeLessThan(page.indexOf('return <Loading />;'));
  });

  it('the guest home opens each event by its event link, else by its call link (an older server)', () => {
    const home = read('features/call/GuestHome.tsx');
    expect(home).toContain('const target = event.linkPath ?? (event.code ? callLinkPath(event.code) : null);');
    expect(home).toContain('onClick={() => { if (target) navigate(target); }}');
  });

  it('with neither link (none could be read just now: rereview 2 minor 3) the button waits, says so, and links nothing dead', () => {
    const home = read('features/call/GuestHome.tsx');
    expect(home).toContain('disabled={!target}');
    expect(home).toContain("{!target ? 'Try again in a moment' : event.step === 'enter' ? 'Join now' : 'Open'}");
    expect(home).toContain('key={event.linkPath ?? event.code ?? `${event.title}:${event.scheduledAt ?? i}`}');
  });
});

describe('the link name on the event forms', () => {
  const values = newEventValues({ pod: null, scheduledAt: '2026-12-01T10:00', timezone: 'Europe/Copenhagen' });

  it('a new event starts with no name (the server gives the default); an edit starts on the event\'s own', () => {
    expect(values.linkName).toBe('');
    const { values: edit } = editEventValues({ title: 'T', timezone: 'UTC', linkName: 'founders' }, '2026-12-01T10:00');
    expect(edit.linkName).toBe('founders');
    expect(editEventValues({ title: 'T', timezone: 'UTC' }, '').values.linkName).toBe('');
  });

  it('is checked in the shared rule\'s words at its field; empty is fine', () => {
    expect(linkNameProblem('')).toBeNull();
    expect(linkNameProblem('   ')).toBeNull();
    expect(linkNameProblem(' Founders ')).toBeNull();
    expect(linkNameProblem('admin')).toBe('That name is kept for REASON itself. Choose another.');
    expect(linkNameProblem('my event')).toBe(EVENT_LINK_NAME_RULE);
    expect(shownEventKeys('speed_networking', false)).toContain('linkName');
    expect(problemSummary(['linkName', 'title'], 'speed_networking')?.items).toEqual([
      { key: 'title', label: 'Title' }, { key: 'linkName', label: 'Event link name' },
    ]);
  });

  it('creating sends the name trimmed and lower-cased, or none at all', () => {
    expect(eventBody({ ...values, podId: 'p', title: 'T', linkName: ' Founders ' }, { isAdmin: false }).linkName).toBe('founders');
    expect('linkName' in eventBody({ ...values, podId: 'p', title: 'T' }, { isAdmin: false })).toBe(false);
  });

  it('editing sends a name only when it changed and was not emptied', () => {
    const opened = { ...values, linkName: 'rsn' };
    const send = (linkName: string) => eventChanges({ ...opened, title: 'T', linkName }, { isAdmin: false, opened });
    expect(send('Founders').linkName).toBe('founders');
    expect('linkName' in send('rsn')).toBe(false);
    expect('linkName' in send(' RSN ')).toBe(false);
    expect('linkName' in send('')).toBe(false);
  });

  it('a refusal for the name lands at its field in the server\'s words', () => {
    const err = { response: { status: 400, data: { error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: { linkName: ['That name is kept for REASON itself. Choose another.'] } } } } };
    expect(eventProblems(err, 'speed_networking', { fallback: 'x', forbidden: 'y', notFound: 'z' }).fields)
      .toEqual({ linkName: 'That name is kept for REASON itself. Choose another.' });
  });

  it('both forms draw the field beside Who can join, and the field reads the link as the organiser pauses', () => {
    expect(read('features/sessions/CreateSessionPage.tsx'))
      .toContain('<EventLinkNameField className="mt-5" form={ev.form} podId={pod?.id} visibility={visibility} circleId={circle?.id} isAdmin={isAdmin} />');
    expect(read('features/sessions/EditEventModal.tsx'))
      .toContain('<EventLinkNameField form={ev.form} sessionId={session.id} visibility={visibility} isAdmin={isAdmin} currentName={session.linkName} />');
    const field = read('features/sessions/EventLinkNameField.tsx');
    expect(field).toContain("api.get('/sessions/event-link-name', {");
    expect(field).toContain("// realtime: skip — the form's as-you-type check of a name, asked again on every pause in typing\n  const check = useQuery");
    expect(field).toContain("{...register('linkName')}");
    // Never a request for a name the form already refuses; the shape is said at once.
    expect(field).toContain('const askable = !!(podId || sessionId) && !(paused && eventLinkNameProblem(paused));');
    // "rsn" is RSN's own (ruling b): "This name is reserved." at once, to anyone but a platform admin; never for the
    // event's own name.
    expect(field).toContain('const shapeProblem = typed && typed !== currentName ? eventLinkNameProblemFor(typed, { platform: isAdmin }) : null;');
  });

  it('the field is a 44px control that wraps a long address (no sideways scroll at 360px)', () => {
    const field = read('features/sessions/EventLinkNameField.tsx');
    expect(field).toContain('className={cn(EVENT_FIELD, fieldBorder(problem ?? undefined)');
    expect(read('features/sessions/EventFormatFields.tsx')).toMatch(/export const EVENT_FIELD = `w-full min-h-\[44px\]/);
    expect(field).toContain('[overflow-wrap:anywhere]');
  });
});

describe('the words: an event link, never a call', () => {
  it('the card, the history and the waiting list say "event link"', () => {
    const card = read('features/sessions/CallLinkCard.tsx');
    expect(card).toContain("title: 'Event link'");
    expect(card).toContain("error: 'The event link could not be read just now.'");
    expect(card).toContain('Links shared while it was public no longer work.');
    expect(historySentence({
      id: '1', at: '', actor: { id: 'h', displayName: 'Ana' }, automatic: false, action: 'call_link.rotated',
      round: null, scheduleVersion: null, subjects: [], reason: null,
    })).toBe('Ana made a new event link');
    expect(read('features/sessions/waitlist/waitlist-text.ts')).toContain("call_link: 'Joined through the event link',");
  });

  it('no text a person reads anywhere in the client says "call link" or "RSN Call" (comments, ids and paths aside)', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(e.name)) files.push(full);
      }
    };
    walk(CLIENT);
    const found: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/\{\/\*.*?\*\/\}/g, '').trim();
        if (code.startsWith('*') || code.startsWith('/*')) return;
        // Quoted text only: a string or a template that a person could read.
        for (const m of code.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
          const text = m[2];
          if (/^\/|call-link|^call-|session-call-link/i.test(text)) continue;
          if (/\bcall link\b|\bRSN Call\b|\bJoin call\b/i.test(text)) found.push(`${path.relative(CLIENT, file)}:${i + 1}: ${text}`);
        }
      });
      // JSX text too (between > and <, across lines), comments taken out first.
      const jsx = fs.readFileSync(file, 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const m of jsx.matchAll(/>([^<>{}]+)</g)) {
        const text = m[1].replace(/\s+/g, ' ').trim();
        if (text && /\bcall link\b|\bRSN Call\b|\bJoin call\b/i.test(text)) found.push(`${path.relative(CLIENT, file)} (JSX): ${text}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('the JSX pass would catch text between tags', () => {
    const text = '<p>Share the call link</p>'.match(/>([^<>{}]+)</)?.[1] ?? '';
    expect(/\bcall link\b/i.test(text)).toBe(true);
  });
});
