// server/src/__tests__/client/meetings-ui.test.ts
// Meetings under Events, the meeting's own page and the Events count (26 Oct 2026, CON-04/05 client).
//
// Stefan, 25 Oct: "it goes into Events: 'we have a meeting at 12' ... there should be a little number on Events ...
// and when I click it: 'You have a meeting with Stefan at 1 o'clock today.'" The server half (S3) keeps each agreed
// meeting as its own record; these screens read it.
//
// meeting-words.ts is run for real: it has no React, axios, store or router behind it. The screens are read as source,
// like the other client pins (the client has no test runner of its own).
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import type { Meeting, MeetingSummary } from '@rsn/shared';
import {
  canJoin, eventsBadge, eventsLinkName, firstLine, isMeetingId, kindLabel, meetingChip, meetingDay, meetingError,
  meetingLine, meetingTimes, meetingWhen, nextChangeAt, startsIn, tickDelay, EMPTY_MEETINGS, NO_PAST_MEETINGS,
  NO_CANCELLED_MEETINGS,
} from '../../../../client/src/features/meetings/meeting-words';

const CLIENT = path.join(__dirname, '../../../../client/src');
// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');

const MIN = 60_000;
const CPH = 'Europe/Copenhagen';
// Copenhagen left summer time at 01:00 UTC on 25 Oct 2026, so 12:00 UTC that day is 13:00 CET. Node's own time-zone
// data names the zone CET or GMT+1, depending on the build; both name it.
const CET = '(CET|GMT\\+1)';
const CEST = '(CEST|GMT\\+2)';

const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  id: 'm-1',
  conversationId: 'c-1',
  partner: { userId: 'u-2', displayName: 'Stefan Avivson', avatarUrl: null },
  startAt: '2026-10-25T12:00:00.000Z',
  durationMin: 30,
  kind: 'video',
  status: 'scheduled',
  phase: 'upcoming',
  context: 'Coffee about your seed round?',
  joinPath: '/meet/c-1?scheduled=1&kind=video',
  attended: { me: false, them: false },
  ...over,
});
const START = Date.parse('2026-10-25T12:00:00.000Z');
const END = START + 30 * MIN;

describe('when a meeting is: the reader\'s own time, with the zone named', () => {
  it('a card reads "Sun 25 Oct · 13:00–13:30 CET · Video" in Copenhagen', () => {
    expect(meetingWhen(meeting().startAt, 30, CPH)).toMatch(new RegExp(`^Sun 25 Oct · 13:00–13:30 ${CET}$`));
    expect(meetingLine(meeting(), CPH)).toMatch(new RegExp(`^Sun 25 Oct · 13:00–13:30 ${CET} · Video$`));
    expect(meetingLine(meeting({ kind: 'audio' }), CPH)).toMatch(/ · Audio$/);
  });

  it('the same instant reads in the reader\'s own zone: 17:00 in Karachi, 12:00 in UTC', () => {
    expect(meetingWhen(meeting().startAt, 30, 'Asia/Karachi')).toMatch(/^Sun 25 Oct · 17:00–17:30 (PKT|GMT\+5)$/);
    expect(meetingWhen(meeting().startAt, 30, 'UTC')).toBe('Sun 25 Oct · 12:00–12:30 UTC');
  });

  it('names summer time as summer time (the day before the clocks went back)', () => {
    expect(meetingWhen('2026-10-24T12:00:00Z', 45, CPH)).toMatch(new RegExp(`^Sat 24 Oct · 14:00–14:45 ${CEST}$`));
  });

  it('writes the day as a number and every month in three letters (en-GB writes "05" and "Sept")', () => {
    expect(meetingWhen('2026-11-05T17:00:00Z', 30, 'Europe/Berlin')).toMatch(new RegExp(`^Thu 5 Nov · 18:00–18:30 ${CET}$`));
    expect(meetingWhen('2026-09-09T08:00:00Z', 20, 'UTC')).toBe('Wed 9 Sep · 08:00–08:20 UTC');
  });

  it('a meeting that runs past midnight ends at 00:15, on the clock', () => {
    expect(meetingWhen('2026-10-25T22:45:00Z', 30, CPH)).toMatch(new RegExp(`^Sun 25 Oct · 23:45–00:15 ${CET}$`));
  });

  it('the meeting\'s page spells the day out and gives the times with the zone', () => {
    expect(meetingDay(meeting().startAt, CPH)).toBe('Sunday 25 October');
    expect(meetingTimes(meeting().startAt, 30, CPH)).toMatch(new RegExp(`^13:00–13:30 ${CET}$`));
  });

  it('says Video or Audio', () => {
    expect(kindLabel('video')).toBe('Video');
    expect(kindLabel('audio')).toBe('Audio');
  });
});

describe('why: the first line of the request\'s words', () => {
  it('is the first line with words in it, trimmed', () => {
    expect(firstLine('Coffee about your seed round?\nI can bring the deck.')).toBe('Coffee about your seed round?');
    expect(firstLine('\r\n  \r\n  Hello there  \r\nsecond')).toBe('Hello there');
  });
  it('is nothing when there are no words', () => {
    expect(firstLine(null)).toBeNull();
    expect(firstLine('')).toBeNull();
    expect(firstLine(' \n\t \n')).toBeNull();
  });
});

describe('Join: open from 5 minutes before the start until 30 minutes after the end, the server\'s own rule', () => {
  it('is closed until 5 minutes before, then open through the meeting and the 30 minutes after it', () => {
    const m = meeting();
    expect(canJoin(m, START - 5 * MIN - 1)).toBe(false);
    expect(canJoin(m, START - 5 * MIN)).toBe(true);
    expect(canJoin(m, START + 10 * MIN)).toBe(true);
    expect(canJoin(m, END + 30 * MIN)).toBe(true);
    expect(canJoin(m, END + 30 * MIN + 1)).toBe(false);
  });
  it('a cancelled meeting never opens', () => {
    expect(canJoin(meeting({ status: 'cancelled', phase: 'cancelled' }), START)).toBe(false);
  });
  it('until then it says when it starts, in words', () => {
    expect(startsIn(meeting().startAt, START - 2 * 60 * MIN)).toBe('Starts in 2 h');
    expect(startsIn(meeting().startAt, START - 25 * MIN)).toBe('Starts in 25 min');
    expect(startsIn(meeting().startAt, START - 59 * MIN)).toBe('Starts in 59 min');
    expect(startsIn(meeting().startAt, START - 60 * MIN)).toBe('Starts in 1 h');
    expect(startsIn(meeting().startAt, START - 90 * MIN)).toBe('Starts in 1 h 30 min');
    // A part of a minute counts as a minute: at 5½ minutes before, Join opens in half a minute.
    expect(startsIn(meeting().startAt, START - 5.5 * MIN)).toBe('Starts in 6 min');
    expect(startsIn(meeting().startAt, START - (23 * 60 + 59) * MIN)).toBe('Starts in 23 h 59 min');
    expect(startsIn(meeting().startAt, START - 24 * 60 * MIN)).toBe('Starts in 1 day');
    expect(startsIn(meeting().startAt, START - 36 * 60 * MIN)).toBe('Starts in 2 days');
    expect(startsIn(meeting().startAt, START - 3 * 24 * 60 * MIN)).toBe('Starts in 3 days');
  });
});

describe('the chip on a meeting: Today, Live now, Ended or Cancelled', () => {
  it('Live now whenever Join is open; Ended after; Cancelled whatever the time', () => {
    expect(meetingChip(meeting(), START - 5 * MIN, CPH)).toBe('Live now');
    expect(meetingChip(meeting(), START + 10 * MIN, CPH)).toBe('Live now');
    expect(meetingChip(meeting(), END + 30 * MIN, CPH)).toBe('Live now');
    expect(meetingChip(meeting(), END + 30 * MIN + 1, CPH)).toBe('Ended');
    expect(meetingChip(meeting({ status: 'cancelled', phase: 'cancelled' }), START - 60 * MIN, CPH)).toBe('Cancelled');
  });
  it('Today for a meeting later on the reader\'s own today, and no chip for a later day', () => {
    // 08:00 UTC on the 25th. The meeting is at 22:30 UTC: 23:30 that day in Copenhagen, 03:30 the next day in Karachi.
    const now = Date.parse('2026-10-25T08:00:00Z');
    const late = meeting({ startAt: '2026-10-25T22:30:00.000Z' });
    expect(meetingChip(late, now, CPH)).toBe('Today');
    expect(meetingChip(late, now, 'Asia/Karachi')).toBeNull();
    expect(meetingChip(meeting({ startAt: '2026-10-27T12:00:00.000Z' }), now, CPH)).toBeNull();
    // The same date a month or a year on is not today.
    expect(meetingChip(meeting({ startAt: '2026-11-25T12:00:00.000Z' }), now, CPH)).toBeNull();
    expect(meetingChip(meeting({ startAt: '2027-10-25T12:00:00.000Z' }), now, CPH)).toBeNull();
  });
});

describe('the clock: a meeting\'s screens redraw at the moment it changes, not a tick later', () => {
  it('the next change is the soonest of: Join opening, Join closing; a cancelled meeting never changes', () => {
    const later = meeting({ id: 'm-2', startAt: '2026-10-25T15:00:00.000Z' });
    expect(nextChangeAt([meeting(), later], START - 60 * MIN)).toBe(START - 5 * MIN);
    expect(nextChangeAt([meeting(), later], START)).toBe(END + 30 * MIN + 1);
    expect(nextChangeAt([meeting({ status: 'cancelled', phase: 'cancelled' })], START - 60 * MIN)).toBeNull();
    expect(nextChangeAt([], START)).toBeNull();
    // Once both have ended there is nothing left to wait for.
    expect(nextChangeAt([meeting(), later], Date.parse('2026-10-26T00:00:00Z'))).toBeNull();
  });
  it('the timer waits for the sooner of its tick and that change, never for nothing, never past a day', () => {
    const now = START - 60 * MIN;
    expect(tickDelay(now, 30_000, null)).toBe(30_000);
    expect(tickDelay(now, 30_000, now + 10_000)).toBe(10_050);
    expect(tickDelay(now, 30_000, now - 1)).toBe(30_000);
    expect(tickDelay(now, null, now + 10_000)).toBe(10_050);
    expect(tickDelay(now, null, null)).toBeNull();
    expect(tickDelay(now, null, now - 1)).toBeNull();
    // A meeting weeks away: a browser timer overflows past 24.8 days, so it wakes once a day and looks again.
    expect(tickDelay(now, null, now + 40 * 24 * 60 * MIN)).toBe(24 * 60 * MIN);
  });
});

describe('the Events count', () => {
  const summary = (over: Partial<MeetingSummary> = {}): MeetingSummary => ({
    upcomingCount: 2,
    liveNow: false,
    next: { id: 'm-1', startAt: meeting().startAt, partnerName: 'Stefan Avivson' },
    ...over,
  });

  it('names the count in the link\'s accessible name: "Events, 1 upcoming meeting"', () => {
    expect(eventsLinkName('Events', 0, false)).toBe('Events');
    expect(eventsLinkName('Events', 1, false)).toBe('Events, 1 upcoming meeting');
    expect(eventsLinkName('Events', 3, false)).toBe('Events, 3 upcoming meetings');
    expect(eventsLinkName('Events', 1, true)).toBe('Events, 1 upcoming meeting, live now');
  });

  it('shows nothing until the count has come, and nothing for none', () => {
    expect(eventsBadge(undefined, undefined, START)).toEqual({ count: 0, liveNow: false, wakeAt: null, outOfDate: false });
    expect(eventsBadge({ upcomingCount: 0, liveNow: false, next: null }, undefined, START)).toEqual({ count: 0, liveNow: false, wakeAt: null, outOfDate: false });
  });

  it('counts what the server counted, and wakes when the next meeting can be joined', () => {
    expect(eventsBadge(summary(), undefined, START - 60 * MIN)).toEqual({ count: 2, liveNow: false, wakeAt: START - 5 * MIN, outOfDate: false });
  });

  it('the live dot follows the clock: on from 5 minutes before, even when the count was fetched earlier', () => {
    expect(eventsBadge(summary(), undefined, START - 4 * MIN)).toMatchObject({ count: 2, liveNow: true });
    expect(eventsBadge(summary({ liveNow: true }), undefined, START - 60 * MIN)).toMatchObject({ liveNow: true });
  });

  it('with the next meeting\'s length known, it wakes when that meeting closes, and then the count is out of date', () => {
    const next = meeting();
    expect(eventsBadge(summary(), next, START + 10 * MIN)).toEqual({ count: 2, liveNow: true, wakeAt: END + 30 * MIN + 1, outOfDate: false });
    expect(eventsBadge(summary({ liveNow: true }), next, END + 31 * MIN)).toEqual({ count: 2, liveNow: false, wakeAt: null, outOfDate: true });
    expect(eventsBadge(summary(), meeting({ status: 'cancelled', phase: 'cancelled' }), START - 60 * MIN)).toMatchObject({ liveNow: false, outOfDate: true });
  });

  it('a meeting read for an earlier "next" is not this one, and says nothing about it', () => {
    expect(eventsBadge(summary(), meeting({ id: 'm-old', durationMin: 5 }), START + 10 * MIN)).toEqual({ count: 2, liveNow: true, wakeAt: null, outOfDate: false });
  });
});

describe('the words people read on these screens', () => {
  it('the empty Events list, verbatim, and its two siblings', () => {
    expect(EMPTY_MEETINGS).toBe('No meetings yet. When you and someone agree a time, it appears here.');
    expect(NO_PAST_MEETINGS).toBe('No past meetings yet.');
    expect(NO_CANCELLED_MEETINGS).toBe('No cancelled meetings.');
  });

  // What axios hands a catch block when the server refused: the error envelope under response.data.
  const refused = (status: number, message?: string) => ({ isAxiosError: true, response: { status, data: { success: false, error: { message } } } });
  const FALLBACK = 'We could not cancel the meeting. Try again in a moment.';

  it('a failed meeting request: a 404 is the meeting (never "this person"), an ended one says so, the rest as everywhere', () => {
    expect(meetingError(refused(404, "We couldn't find that meeting."), FALLBACK)).toBe("We couldn't find that meeting.");
    expect(meetingError(refused(404, 'Meeting with id 3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03 not found'), FALLBACK)).toBe("We couldn't find that meeting.");
    expect(meetingError(refused(409, 'This meeting has already ended.'), FALLBACK)).toBe('This meeting has already ended.');
    expect(meetingError(refused(429, 'You have cancelled a lot of meetings this hour. Try again later.'), FALLBACK)).toBe('Slow down a moment, then try again.');
    expect(meetingError(refused(500, 'Internal server error'), FALLBACK)).toBe(FALLBACK);
    expect(meetingError({ isAxiosError: true, code: 'ERR_NETWORK', request: {} }, FALLBACK)).toBe('Connection lost. Check your internet and try again.');
  });

  it('a meeting id is a uuid in either case; anything else is no meeting and is never asked for', () => {
    expect(isMeetingId('3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03')).toBe(true);
    expect(isMeetingId('3F2B8A4E-1C9D-4E7A-B6F0-2A5C8D1E9F03')).toBe(true);
    for (const id of ['', 'summary', '3f2b8a4e', '../sessions', '3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03x']) expect({ id, ok: isMeetingId(id) }).toEqual({ id, ok: false });
  });
});

// ── Source pins ─────────────────────────────────────────────────────────────────────────────

describe('what the meetings screens ask the server for, and what refreshes them', () => {
  const hooks = () => read('features/meetings/useMeetings.ts');

  it('the lists, the count and one meeting each come from the meetings API', () => {
    const src = hooks();
    expect(src).toMatch(/api\.get\('\/meetings', \{ params: \{ scope, limit: PAGE_SIZE, \.\.\.\(before \? \{ before \} : \{\}\) \} \}\)/);
    expect(src).toMatch(/api\.get\('\/meetings\/summary'\)/);
    expect(src).toMatch(/api\.get\(`\/meetings\/\$\{encodeURIComponent\(id\)\}`\)/);
    expect(src).toMatch(/api\.post\(`\/meetings\/\$\{encodeURIComponent\(id\)\}\/cancel`\)/);
  });

  // The realtime guard (scripts/check-realtime-entities.js) does not read useInfiniteQuery, so this pin is the list's guard.
  it('a list declares the member\'s meetings tag (and blocks: a block hides the pair\'s meetings either way)', () => {
    const list = hooks().match(/useInfiniteQuery\(\{[\s\S]*?\n {2}\}\);/);
    expect(list).not.toBeNull();
    expect(list![0]).toMatch(/queryKey: meetingKeys\.list\(scope\)/);
    expect(list![0]).toMatch(/getNextPageParam: \(last\) => last\.nextBefore \?\? undefined/);
    expect(list![0]).toMatch(/meta: \{ entities: me \? \[E\.userMeetings\(me\), E\.userBlocks\(me\)\] : \[\] \}/);
  });

  it('the count declares the member\'s meetings tag; one meeting declares its own', () => {
    const src = hooks();
    expect(src).toMatch(/queryKey: meetingKeys\.summary,[\s\S]{0,200}meta: \{ entities: me \? \[E\.userMeetings\(me\), E\.userBlocks\(me\)\] : \[\] \}/);
    expect(src).toMatch(/queryKey: meetingKeys\.detail\(id \?\? ''\),[\s\S]{0,300}meta: \{ entities: id && me \? \[E\.meeting\(id\), E\.userBlocks\(me\)\] : \[\] \}/);
  });

  it('a cancel refreshes every meetings read as it settles (the server tells both screens too), and sets nothing by hand', () => {
    const src = hooks();
    expect(src).toMatch(/onSettled: \(\) => qc\.invalidateQueries\(\{ queryKey: meetingKeys\.all \}\)/);
    expect(src).not.toMatch(/setQueryData/);
  });

  it('the count refreshes itself once its next meeting has closed, sharing one request between the rail and the phone bar', () => {
    expect(hooks()).toMatch(/if \(badge\.outOfDate\) void qc\.invalidateQueries\(\{ queryKey: meetingKeys\.summary \}, \{ cancelRefetch: false \}\);/);
  });
});

describe('the meeting\'s page lives inside the REASON shell, under Events', () => {
  const loadNav = () => {
    const source = fs.readFileSync(path.join(CLIENT, 'features/reason/shell/nav.ts'), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } });
    const mod: { exports: Record<string, unknown> } = { exports: {} };
    new Function('module', 'exports', 'require', outputText)(mod, mod.exports, require);
    return mod.exports as { MAIN_NAV: Array<{ key: string; match: (p: string) => boolean }> };
  };

  it('App routes /meetings/:meetingId inside the shell', () => {
    const app = read('App.tsx');
    expect(app).toMatch(/^import MeetingDetailPage from '@\/features\/meetings\/MeetingDetailPage';$/m);
    const shellRoutes = app.slice(app.indexOf('<ReasonShell />'), app.indexOf('{/* Protected without layout'));
    expect(shellRoutes).toContain('<Route path="/meetings/:meetingId" element={<MeetingDetailPage />} />');
  });

  it('Events is the current entry on Events, an event, and a meeting\'s page, and on nothing else', () => {
    const events = loadNav().MAIN_NAV.find((i) => i.key === 'events')!;
    for (const url of ['/sessions', '/sessions/s1', '/meetings/m1']) expect({ url, current: events.match(url) }).toEqual({ url, current: true });
    for (const url of ['/', '/meetingsx', '/meet/c1', '/messages']) expect({ url, current: events.match(url) }).toEqual({ url, current: false });
  });
});

describe('Events: "Your meetings" above the events, one filter for both, kept in the address', () => {
  const page = () => read('features/sessions/SessionsPage.tsx');

  it('reads the filter from ?filter= (Upcoming when absent or unknown) and writes it back without a new history step', () => {
    const src = page();
    expect(src).toMatch(/const filter = toFilter\(searchParams\.get\('filter'\)\);/);
    expect(src).toMatch(/setSearchParams\(next === 'upcoming' \? \{\} : \{ filter: next \}, \{ replace: true \}\)/);
    expect(src).not.toMatch(/useState<EventFilter>/);
  });

  it('offers Upcoming, Past and Cancelled, each a 44px pressed-or-not button', () => {
    const src = page();
    expect(src).toMatch(/const FILTERS: Array<\{ key: EventFilter; label: string \}> = \[\s*\{ key: 'upcoming', label: 'Upcoming' \},\s*\{ key: 'past', label: 'Past' \},\s*\{ key: 'cancelled', label: 'Cancelled' \},\s*\];/);
    expect(src).toMatch(/aria-pressed=\{filter === f\.key\}/);
    expect(src).toMatch(/min-h-\[44px\]/);
  });

  it('puts the meetings first, then the events', () => {
    const src = page();
    const meetings = src.indexOf('<MeetingsSection scope={filter} />');
    const events = src.indexOf('aria-labelledby="pod-events-title"');
    expect(meetings).toBeGreaterThan(-1);
    expect(events).toBeGreaterThan(meetings);
  });
});

describe('a meeting on Events', () => {
  const section = () => read('features/meetings/MeetingsSection.tsx');

  it('has a heading, and loading, error and empty states', () => {
    const src = section();
    expect(src).toMatch(/Your meetings/);
    expect(src).toMatch(/aria-busy="true"/);
    expect(src).toMatch(/We could not load your meetings just now\./);
    expect(src).toMatch(/EMPTY_MEETINGS/);
  });

  it('a card: "Meeting with {name}", the time line, the first line of why, the chip, Join or when it starts, and Open chat', () => {
    const src = read('features/meetings/MeetingCard.tsx');
    expect(src).toMatch(/Meeting with \{name\}/);
    expect(src).toMatch(/meetingLine\(meeting\)/);
    expect(src).toMatch(/firstLine\(meeting\.context\)/);
    expect(src).toMatch(/meetingChip\(meeting, now\)/);
    expect(src).toMatch(/<JoinOrCountdown meeting=\{meeting\} now=\{now\}/);
    expect(src).toMatch(/to=\{`\/meetings\/\$\{encodeURIComponent\(meeting\.id\)\}`\}/);
    expect(src).toMatch(/to=\{`\/messages\/\$\{encodeURIComponent\(meeting\.conversationId\)\}`\}/);
    expect(src).toMatch(/>\s*Open chat\s*</);
  });

  it('Join (the card\'s, the page\'s and the phone bar\'s) opens the pair\'s room while it can be joined, and until then says when it starts', () => {
    const src = read('features/meetings/MeetingParts.tsx');
    expect(src).toMatch(/if \(canJoin\(meeting, now\)\) \{[\s\S]*?<Link to=\{meeting\.joinPath\}/);
    expect(src).toMatch(/if \(meetingPhase\(meeting, now\) !== 'upcoming'\) return null;/);
    expect(src).toMatch(/\{startsIn\(meeting\.startAt, now\)\}/);
  });
});

describe('the meeting\'s page', () => {
  const detail = () => read('features/meetings/MeetingDetailPage.tsx');

  it('who (the other person opens in the same tab), when, how and why', () => {
    const src = detail();
    expect(src).toMatch(/personHref\(meeting\.partner\.userId, 'Events'\)/);
    expect(src).not.toMatch(/target="_blank"/);
    expect(src).toMatch(/meetingDay\(meeting\.startAt\)/);
    expect(src).toMatch(/meetingTimes\(meeting\.startAt, meeting\.durationMin\)/);
    expect(src).toMatch(/meeting\.context/);
  });

  it('its actions: Join, Add to calendar, Reschedule (to the chat\'s scheduler), Cancel meeting, Open conversation', () => {
    const src = detail();
    expect(src).toMatch(/>\s*Add to calendar\s*</);
    expect(src).toMatch(/`\/messages\/\$\{encodeURIComponent\(meeting\.conversationId\)\}\?schedule=1`/);
    expect(src).toMatch(/>\s*Reschedule\s*</);
    expect(src).toMatch(/>\s*Cancel meeting\s*</);
    expect(src).toMatch(/>\s*Open conversation\s*</);
    expect(src).toMatch(/api\.get\(`\/dm\/conversations\/\$\{encodeURIComponent\(meeting\.conversationId\)\}\/meeting\.ics`, \{ responseType: 'blob' \}\)/);
  });

  it('Cancel asks first, in a sheet portalled to the page: "Cancel this meeting? {name} will be told."', () => {
    const src = detail();
    expect(src).toMatch(/<Sheet\b/);
    expect(src).toMatch(/title=\{`Cancel this meeting\? \$\{name\} will be told\.`\}/);
  });

  // Measured in Chromium at 360: a sticky box keeps to its scroll area's padding, so a bar set 69px up from <main>'s
  // foot floated 96px above the bottom bar. The offset is worked out here from the two numbers it depends on.
  it('on a phone, Join sits in a bar right on top of the bottom bar, edge to edge, its sides clear of the notch', () => {
    const bar = detail().match(/className="sticky bottom-\[(-?\d+)px\] [^"]*min-\[721px\]:hidden"/);
    expect(bar).not.toBeNull();
    const shell = read('features/reason/shell/ReasonShell.tsx');
    const mainFoot = Number(shell.match(/<main ref=\{main\} className="[^"]*\bpb-\[calc\((\d+)px\+env\(safe-area-inset-bottom\)\)\]/)?.[1]);
    const nav = read('features/reason/shell/MobileNav.tsx');
    const tab = Number(nav.match(/const TAB = '[^']*\bmin-h-\[(\d+)px\]/)?.[1]);
    const above = Number(nav.match(/<nav[^>]*\bpt-(\d+(?:\.\d+)?)\b/)?.[1]) * 4; // Tailwind: n * 0.25rem = n * 4px
    const below = Number(nav.match(/<nav[^>]*\bpb-\[calc\((\d+)px\+env\(safe-area-inset-bottom\)\)\]/)?.[1]);
    expect(nav).toMatch(/<nav[^>]*\bborder-t\b/);
    for (const n of [mainFoot, tab, above, below]) expect(Number.isFinite(n)).toBe(true);
    // Both carry the home-indicator inset, so it cancels: 69 - 96 = -27.
    expect(Number(bar![1])).toBe(1 + above + tab + below - mainFoot);
    // Edge to edge, with <main>'s own sides.
    for (const side of ['left', 'right']) expect(shell).toMatch(new RegExp(`p${side[0]}-\\[max\\(13px,env\\(safe-area-inset-${side}\\)\\)\\]`));
    expect(bar![0]).toMatch(/-ml-\[max\(13px,env\(safe-area-inset-left\)\)\] -mr-\[max\(13px,env\(safe-area-inset-right\)\)\]/);
    expect(bar![0]).toMatch(/pl-\[max\(13px,env\(safe-area-inset-left\)\)\] pr-\[max\(13px,env\(safe-area-inset-right\)\)\]/);
  });
});

describe('the Events count in the navigation', () => {
  it('the rail and the sidebar name it in the link and draw the number and the live dot', () => {
    const side = read('features/reason/shell/ShellSidebar.tsx');
    expect(side).toMatch(/const meetings = useEventsBadge\(\);/);
    expect(side).toMatch(/eventsLinkName\(item\.label, meetings\.count, meetings\.liveNow\)/);
    expect(side).toMatch(/data-live-now/);
  });

  it('the phone bar names it in the tab and draws the number and the live dot', () => {
    const bar = read('features/reason/shell/MobileNav.tsx');
    expect(bar).toMatch(/const meetings = useEventsBadge\(\);/);
    expect(bar).toMatch(/eventsLinkName\(item\.label, meetings\.count, meetings\.liveNow\)/);
    expect(bar).toMatch(/data-live-now/);
  });
});
