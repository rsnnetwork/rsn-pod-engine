// server/src/__tests__/client/p3-event-time-image.test.ts
// Part 3 Task 6 (10 Nov 2026 spec, item 1; plan K1 and Review Focus #3): the screens of Task 1's event time zone and
// event image.
//
// 1. A time shown in the wrong zone: an organiser in Karachi sets up a Copenhagen evening at 14:00; the form sends
//    13:00Z with timezone 'Europe/Copenhagen', and the edit form opens on 14:00 again. Every displayed EVENT time goes
//    through the event-zone helpers and names the zone; "(your local time)" is gone from beside event times.
// 2. The image: a 3:1 box with no layout jump, lazy in lists; only the event's host or an admin sees "Change image" /
//    "Remove image" (44px); the editor's query declares session:<id>; nothing writes into a cached answer.
import * as fs from 'fs';
import * as path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TIME_ZONE_REQUIRED, editEventValues, eventBody, eventChanges, eventChangesSchema, eventProblems, eventWallTime,
  newEventSchema, newEventValues, shownEventKeys, type EventFormValues,
} from '../../../../client/src/features/sessions/event-format-form';
import { nextQuarterHourAfter } from '../../../../client/src/features/sessions/default-start';
import { defaultEventZone, eventDateTile, eventWhen, formZone } from '../../../../client/src/lib/event-time';
import { eventTimeLabel, startsPhrase, youreInSentence } from '../../../../client/src/features/call/call-entry';
import { publishedAtLabel, startsAtLabel } from '../../../../client/src/features/schedule/board-model';
import { formResolver } from '../../../../client/src/lib/form-resolver';
import { iconStandIns, loadClientModule, readClientSource } from './load-client-module';

const read = readClientSource;
const CLIENT = path.join(__dirname, '../../../../client/src');
const reasonPod = { id: 'pod-1', name: 'Test', podType: 'reason', orchestrationMode: 'free_form' } as const;

// ─── 1. The forms: the event's own clock, both ways ─────────────────────────────────────────────────────────────────

describe('the event forms read and write the time on the EVENT zone, never the browser', () => {
  it('an organiser in Karachi, a Copenhagen event, 1 Dec 14:00: sends 13:00Z and the zone, and opens on 14:00 again', () => {
    // A new event starts on the organiser's own zone.
    const start = newEventValues({ pod: reasonPod as never, scheduledAt: '2026-12-01T14:00', timezone: defaultEventZone('Asia/Karachi') });
    expect(start.timezone).toBe('Asia/Karachi');
    // Picking Copenhagen keeps the wall clock: the field still reads 14:00.
    const copenhagen: EventFormValues = { ...start, timezone: 'Europe/Copenhagen' };
    expect(copenhagen.scheduledAt).toBe('2026-12-01T14:00');

    const body = eventBody(copenhagen, { isAdmin: false });
    expect(body.scheduledAt).toBe('2026-12-01T13:00:00.000Z');
    expect(body.timezone).toBe('Europe/Copenhagen');

    // Whoever opens the edit form, wherever they are, it opens on Copenhagen's 14:00.
    const wall = eventWallTime({ scheduledAt: body.scheduledAt, timezone: body.timezone });
    expect(wall).toBe('2026-12-01T14:00');
    const { values } = editEventValues({ title: 'Evening', format: 'video_meeting', config: {}, timezone: 'Europe/Copenhagen' }, wall);
    expect(values.timezone).toBe('Europe/Copenhagen');
    expect(eventChanges(values, { isAdmin: false })).toMatchObject({ scheduledAt: '2026-12-01T13:00:00.000Z', timezone: 'Europe/Copenhagen' });
    // The same 14:00 in Karachi is another instant: the zone, not the browser, decides.
    expect(eventBody(start, { isAdmin: false }).scheduledAt).toBe('2026-12-01T09:00:00.000Z');
  });

  it('a new zone with the same wall clock is a new instant (the edit sends it, so the server tells people it moved)', () => {
    const { values } = editEventValues({ title: 'Evening', format: 'video_meeting', config: {}, timezone: 'Europe/Copenhagen' }, '2026-12-01T14:00');
    expect(eventChanges({ ...values, timezone: 'Europe/London' }, { isAdmin: false }))
      .toMatchObject({ scheduledAt: '2026-12-01T14:00:00.000Z', timezone: 'Europe/London' });
  });

  it('summer time and its edges: 2 Jul is CEST; the spring gap reads later; the autumn overlap is the first', () => {
    const v = (scheduledAt: string): EventFormValues => ({
      ...newEventValues({ pod: reasonPod as never, scheduledAt, timezone: 'Europe/Copenhagen' }),
    });
    expect(eventBody(v('2026-07-02T14:00'), { isAdmin: false }).scheduledAt).toBe('2026-07-02T12:00:00.000Z');
    expect(eventBody(v('2026-03-29T02:30'), { isAdmin: false }).scheduledAt).toBe('2026-03-29T01:30:00.000Z');
    expect(eventBody(v('2026-10-25T02:30'), { isAdmin: false }).scheduledAt).toBe('2026-10-25T00:30:00.000Z');
  });

  it('the zone a new event starts on: the organiser\'s real profile zone, else the browser\'s, else UTC; never an offset', () => {
    expect(defaultEventZone('Europe/Madrid')).toBe('Europe/Madrid');
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(defaultEventZone(null)).toBe(formZone(browser));
    expect(defaultEventZone('+05:45')).toBe(formZone(browser));
    expect(defaultEventZone('garbage')).toBe(formZone(browser));
    // A zone the runtime still names by its old name is held by today's (the list marks it).
    expect(formZone('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(formZone(undefined)).toBe('UTC');
  });

  it('a new event\'s first time is the next quarter hour on the EVENT zone\'s clock', () => {
    const at = new Date('2026-12-01T12:07:00Z');
    expect(nextQuarterHourAfter(at, 'Europe/Copenhagen')).toBe('2026-12-01T13:15');
    expect(nextQuarterHourAfter(at, 'Asia/Kathmandu')).toBe('2026-12-01T18:00');
  });

  it('a zone that is not one is said at the time zone field (both forms), in the server\'s words', async () => {
    const bad = { ...newEventValues({ pod: reasonPod as never, scheduledAt: '2026-12-01T14:00', timezone: 'Europe/Copenhagen' }), timezone: 'Mars/Base' };
    for (const schema of [newEventSchema, eventChangesSchema]) {
      const r = await formResolver(schema)(bad, undefined, {} as never);
      expect(Object.keys(r.errors)).toEqual(['timezone']);
      expect((r.errors as Record<string, { message?: string }>).timezone.message).toBe(TIME_ZONE_REQUIRED);
    }
    const refused = { response: { status: 400, data: { error: { code: 'VALIDATION_ERROR', message: TIME_ZONE_REQUIRED, details: { timezone: [TIME_ZONE_REQUIRED] } } } } };
    expect(eventProblems(refused, 'video_meeting', { fallback: 'x', forbidden: 'x', notFound: 'x' }))
      .toEqual({ fields: { timezone: TIME_ZONE_REQUIRED }, form: null });
    expect(shownEventKeys('video_meeting', false)).toContain('timezone');
  });

  it('the create and edit forms hold the zone in TimeZoneField and say "Times are shown in {zone}."', () => {
    for (const rel of ['features/sessions/CreateSessionPage.tsx', 'features/sessions/EditEventModal.tsx']) {
      const src = read(rel);
      expect(src).toContain('<EventZoneField');
      expect(src).not.toMatch(/Shown in your local time|in their own timezone|localTimezoneLabel|toLocalDatetimeInput/);
    }
    const field = read('features/sessions/EventZoneField.tsx');
    expect(field).toContain("from '@/features/onboarding/TimeZoneField'");
    expect(field).toContain('Times are shown in {timeZoneLabel(');
    expect(read('features/sessions/CreateSessionPage.tsx')).toContain('const zone = defaultEventZone(organiserZone)');
    expect(read('features/sessions/CreateSessionPage.tsx')).toContain('nextQuarterHourAfter(new Date(), zone)');
    expect(read('features/sessions/EditEventModal.tsx')).toContain('editEventValues(session, eventWallTime(session))');
    // The form module converts with the shared function, never the browser's Date parser.
    const form = read('features/sessions/event-format-form.ts');
    expect(form).toContain('zonedWallTimeToUtc(values.scheduledAt, values.timezone)');
    expect(form).not.toMatch(/new Date\(local\)|isoFromLocal/);
  });

  it('Duplicate copies the event\'s zone', () => {
    const src = read('features/sessions/SessionDetailPage.tsx');
    const dup = src.slice(src.indexOf('const duplicateMutation'), src.indexOf('const unregisterMutation'));
    expect(dup).toContain('timezone: session?.timezone');
  });
});

// ─── 2. Every displayed event time: the event's zone, named ─────────────────────────────────────────────────────────

describe('every event time on screen is on the event\'s clock with the zone named', () => {
  const at = '2026-12-01T13:00:00.000Z';

  it('the helpers: lists, one event, the call landing, the waiting step, the For You tile and the board', () => {
    expect(eventWhen(at, 'Europe/Copenhagen')).toBe('Tue 1 Dec, 14:00 CET');
    expect(eventWhen(at, 'Europe/Copenhagen', 'long')).toBe('Tuesday 1 December, 14:00 (CET)');
    expect(eventWhen(null, 'Europe/Copenhagen')).toBeNull();
    // A New York viewer sees Copenhagen's 14:00 (their own clock would say 08:00).
    expect(eventWhen(at, 'Europe/Copenhagen')).not.toContain('08:00');
    expect(eventTimeLabel(at, 'Europe/Copenhagen')).toBe('Tuesday 1 December, 14:00 (CET)');
    expect(eventTimeLabel(null, 'Europe/Copenhagen')).toBeNull();
    const now = Date.parse('2026-11-11T10:00:00Z');
    expect(startsPhrase(at, now, 'Europe/Copenhagen')).toBe('on Tuesday 1 December at 14:00 CET');
    expect(startsPhrase(at, now, 'Asia/Karachi')).toBe('on Tuesday 1 December at 18:00 GMT+5');
    expect(youreInSentence('Founders meet funders', at, 'Europe/Copenhagen', now))
      .toBe("You're in. Founders meet funders starts on Tuesday 1 December at 14:00 CET.");
    // The tile's day is the event zone's: 20:00Z on 1 Dec is already 2 Dec in Karachi.
    expect(eventDateTile('2026-12-01T20:00:00.000Z', 'Asia/Karachi')).toEqual({ month: 'DEC', day: '02' });
    expect(eventDateTile(at, 'Europe/Copenhagen')).toEqual({ month: 'DEC', day: '01' });
    expect(startsAtLabel(at, 'Europe/Copenhagen')).toBe('14:00 CET');
    expect(startsAtLabel(null, 'Europe/Copenhagen')).toBeNull();
    // A publish moment is not an event time: it stays on the viewer's clock.
    expect(publishedAtLabel(at)).toBe(new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }));
  });

  it('formatEventDateTime (lib/utils) is the event-zone line, "No date set" without a date', () => {
    const { formatEventDateTime } = loadClientModule('lib/utils.ts', {}) as { formatEventDateTime: (i: string | null, z: string | null) => string };
    expect(formatEventDateTime(at, 'Europe/Copenhagen')).toBe('Tue 1 Dec, 14:00 CET');
    expect(formatEventDateTime(null, 'Europe/Copenhagen')).toBe('No date set');
    expect(formatEventDateTime(at, 'Not/AZone')).toBe('Tue 1 Dec, 13:00 UTC');
  });

  // Each file that shows an event's time, and the part of it that does (a connection's date in the For You rail, a
  // publish moment on the board, are not event times and stay on the viewer's clock).
  const SITES: Array<{ rel: string; helper: RegExp; skip?: (src: string) => string }> = [
    { rel: 'features/sessions/SessionDetailPage.tsx', helper: /eventWhen\(session\.scheduledAt, session\.timezone, 'long'\)/ },
    { rel: 'features/sessions/SessionsPage.tsx', helper: /formatEventDateTime\(s\.scheduledAt, s\.timezone\)/ },
    { rel: 'features/pods/PodEventsSection.tsx', helper: /formatEventDateTime\(s\.scheduledAt, s\.timezone\)/ },
    { rel: 'features/circles/CircleEventsSection.tsx', helper: /formatEventDateTime\(e\.scheduledAt, e\.timezone\)/ },
    { rel: 'features/host/HostDashboardPage.tsx', helper: /formatEventDateTime\(session\.scheduledAt, session\.timezone\)/ },
    { rel: 'features/admin/AdminSessionsPage.tsx', helper: /formatEventDateTime\(session\.scheduledAt, session\.timezone\)/ },
    { rel: 'features/matches/MatchesPage.tsx', helper: /formatEventDateTime\(nextEvent\.scheduledAt, nextEvent\.timezone\)/ },
    {
      rel: 'features/reason/for-you/ForYouRail.tsx',
      helper: /eventDateTile\(nextEvent\.scheduledAt, nextEvent\.timezone\)/,
      skip: (src) => src.split('\n').filter((line) => !line.includes('connectedAt')).join('\n'),
    },
    { rel: 'features/invites/InviteAcceptPage.tsx', helper: /eventWhen\(scheduledAt, invite\?\.sessionTimezone, 'long'\)/ },
    { rel: 'features/call/call-entry.ts', helper: /formatEventTime\(iso, zone, 'long'\)/ },
    { rel: 'features/call/CallEventSummary.tsx', helper: /eventTimeLabel\(landing\.scheduledAt, landing\.timezone\)/ },
    { rel: 'features/call/GuestHome.tsx', helper: /eventTimeLabel\(event\.scheduledAt, event\.timezone\)/ },
    { rel: 'features/call/CallWaitingStep.tsx', helper: /youreInSentence\(landing\.title, startsAt, landing\.timezone\)/ },
    {
      rel: 'features/schedule/board-model.ts',
      helper: /formatEventTime\(at, zone, 'clock'\)/,
      skip: (src) => src.slice(0, src.indexOf('export function publishedAtLabel')) + src.slice(src.indexOf('export const STATUS_LABEL')),
    },
    { rel: 'features/schedule/MatchingBoardPage.tsx', helper: /startsAtLabel\(active\?\.startsAt \?\? null, zone\)/ },
    { rel: 'features/schedule/AllRoundsOverview.tsx', helper: /startsAtLabel\(row\.startsAt, zone\)/ },
    { rel: 'features/schedule/PersonTimeline.tsx', helper: /startsAtLabel\(e\.startsAt, zone\)/ },
  ];

  it.each(SITES)('$rel shows the event time through the event-zone helper, never the browser\'s clock', ({ rel, helper, skip }) => {
    const src = read(rel);
    expect(src).toMatch(helper);
    const shown = skip ? skip(src) : src;
    expect(shown).not.toMatch(/\.toLocaleString\(|\.toLocaleDateString\(|\.toLocaleTimeString\(|\bformatDateTime\(|\.getDate\(\)/);
  });

  it('"(your local time)" no longer appears anywhere, and the call landing no longer says "your own time zone"', () => {
    const all = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return all(full);
      return /\.tsx?$/.test(e.name) ? [full] : [];
    });
    for (const file of all(CLIENT)) {
      const src = fs.readFileSync(file, 'utf8');
      expect({ file, has: /LOCAL_TIME_LABEL/.test(src) }).toEqual({ file, has: false });
    }
    // 1:1 meetings (messages) keep the reader's own clock, and say so; no event screen does.
    for (const { rel } of SITES) expect({ rel, has: /your local time/i.test(read(rel)) }).toEqual({ rel, has: false });
    expect(read('features/call/CallEventSummary.tsx')).not.toContain('Shown in your own time zone');
  });

  it('audit history, chat times and invite dates stay on the viewer\'s own clock (not event times)', () => {
    expect(read('features/sessions/history/EventHistoryPanel.tsx')).toContain('formatDateTime(entry.at)');
    expect(read('features/sessions/event-chat-text.ts')).toContain('toLocaleTimeString');
    expect(read('features/invites/InvitesPage.tsx')).toContain('new Date(inv.createdAt).toLocaleDateString()');
  });
});

// ─── 3. The image ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('the event image', () => {
  it('useEventImage: its query declares session:<id>, it PUTs and DELETEs the image route, and never sets cached data', () => {
    const src = read('features/sessions/useEventImage.ts');
    expect(src).toContain('meta: { entities: [E.session(sessionId)] }');
    expect(src).toContain('api.put(`/sessions/${sessionId}/image`, body)');
    expect(src).toContain('api.delete(`/sessions/${sessionId}/image`)');
    expect(src).toContain('api.get(`/sessions/${sessionId}/image/source`)');
    expect(src).toContain('aspect: 3');
    expect(src).not.toContain('setQueryData');
  });

  const mod = () => loadClientModule('features/sessions/EventImage.tsx', {
    'lucide-react': iconStandIns,
    '@/components/ui/ConfirmDialog': { __esModule: true, default: () => null },
    '@/components/picture/PictureEditor': { __esModule: true, default: () => null },
    './useEventImage': {
      EVENT_IMAGE_WORDS: { add: 'Add image', change: 'Change image', remove: 'Remove image', confirmTitle: 't', confirmBody: 'b' },
      useEventImage: () => ({ edit: () => undefined, remove: async () => undefined, removing: false, busy: false, editor: {} }),
    },
  });
  const header = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(mod().EventImageHeader as never, { sessionId: 's1', title: 'Copenhagen evening', ...props }));
  const buttons = (html: string) => Array.from(html.matchAll(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/g)).map((m) => m[0]);

  it('a member who is neither the host nor an admin sees the image and no control; with no image, nothing', () => {
    const html = header({ src: 'https://api.example/api/sessions/s1/image?v=1', canChange: false });
    expect(html).toContain('alt="Copenhagen evening"');
    expect(html).toContain('loading="eager"');
    expect(buttons(html)).toEqual([]);
    expect(header({ src: null, canChange: false })).toBe('');
  });

  it('the host or an admin sees "Change image" and "Remove image" on the image, and "Add image" without one, each 44px', () => {
    const withImage = buttons(header({ src: 'https://api.example/api/sessions/s1/image?v=1', canChange: true }));
    expect(withImage.map((b) => b.replace(/<[^>]+>/g, ''))).toEqual(['Remove image', 'Change image']);
    for (const b of withImage) expect(b).toContain('min-h-[44px]');
    const without = buttons(header({ src: null, canChange: true }));
    expect(without).toHaveLength(1);
    expect(without[0]).toContain('Add image');
    expect(without[0]).toContain('min-h-[44px]');
  });

  it('a card\'s image: a 3:1 box drawn before the picture arrives, lazy, decorative; none without an image', () => {
    const image = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(mod().default as never, props));
    const html = image({ src: 'https://api.example/api/sessions/s1/image?v=1' });
    expect(html).toContain('aspect-[3/1]');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('alt=""');
    expect(html).toMatch(/width="1200" height="400"/);
    expect(image({ src: null })).toBe('');
  });

  it('only the event\'s host or an admin is given the controls on the event page; lists draw the lazy card image', () => {
    const detail = read('features/sessions/SessionDetailPage.tsx');
    expect(detail).toContain('canChange={isHost || isAdmin}');
    expect(detail).toContain('<EventImageHeader');
    for (const rel of ['features/sessions/SessionsPage.tsx', 'features/pods/PodEventsSection.tsx', 'features/circles/CircleEventsSection.tsx', 'features/call/GuestHome.tsx']) {
      expect(read(rel)).toMatch(/<EventImage src=\{\w+\.imageUrl\}/);
    }
    expect(read('features/call/CallEventSummary.tsx')).toContain('<EventImage src={landing.imageUrl}');
  });
});
