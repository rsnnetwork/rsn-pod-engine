// ─── Shirley pilot S8 (12 Nov 2026): calendar free/busy on the client (brief RSN 10, plan decision D7) ────────────────
// The pure rules run here (calendar-words.ts): which picker cells a busy time shades, the range the picker asks for,
// the return path, the consent words. The screens are pinned by what they must hold: nothing calendar while the server
// has it off, consent before leaving for a provider, busy cells that stay selectable, booking that never reads a
// calendar, every query on its entity tag, 44px taps, and dialogs through the portalled Sheet.

import * as fs from 'fs';
import * as path from 'path';
import {
  BUSY_DAYS, CONSENT_KEEP, appleMobile, CONSENT_LINES, CONSENT_MICROSOFT_NOTE, OUTCOME_MESSAGE, PICKER_UNAVAILABLE, androidBrowserUrl,
  blockedBrowser, busyRange, busySlotKeys, continueUrl, hintDismissedKey, isOutcome, openInBrowserLabel, returnPathFrom,
} from '../../../../client/src/features/calendar/calendar-words';

const SRC = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('busy times on the picker (calendar-words.ts)', () => {
  const slots = ['2026-12-01T08:30:00Z', '2026-12-01T09:00:00Z', '2026-12-01T09:30:00Z', '2026-12-01T10:00:00Z', '2026-12-01T10:30:00Z'];

  it('shades every 30-minute slot a busy stretch overlaps, even by a minute, and no other', () => {
    const busy = [{ start: '2026-12-01T09:15:00.000Z', end: '2026-12-01T10:01:00.000Z' }];
    expect([...busySlotKeys(slots, busy)]).toEqual(['2026-12-01T09:00:00Z', '2026-12-01T09:30:00Z', '2026-12-01T10:00:00Z']);
  });

  it('a stretch that ends as a slot starts does not shade it; nothing busy shades nothing; nonsense is ignored', () => {
    expect([...busySlotKeys(slots, [{ start: '2026-12-01T08:00:00Z', end: '2026-12-01T08:30:00Z' }])]).toEqual([]);
    expect(busySlotKeys(slots, []).size).toBe(0);
    expect(busySlotKeys(slots, [{ start: 'x', end: 'y' }, { start: '2026-12-01T10:00:00Z', end: '2026-12-01T09:00:00Z' }]).size).toBe(0);
  });

  it('an all-day busy day (as the server sends it, on the viewer\'s clock) shades the whole day', () => {
    const day = Array.from({ length: 48 }, (_, i) => new Date(Date.parse('2026-12-02T00:00:00Z') + i * 1_800_000).toISOString().replace('.000Z', 'Z'));
    expect(busySlotKeys(day, [{ start: '2026-12-02T00:00:00.000Z', end: '2026-12-03T00:00:00.000Z' }]).size).toBe(48);
  });

  it('asks for the next eight days from the start of this UTC hour, the same question all hour (the server caches it)', () => {
    const at = Date.parse('2026-12-01T09:41:13Z');
    expect(busyRange(at)).toEqual({ from: '2026-12-01T09:00:00.000Z', to: '2026-12-09T09:00:00.000Z' });
    expect(busyRange(at + 15 * 60_000)).toEqual(busyRange(at));
    expect(BUSY_DAYS).toBe(8);
  });

  it('comes back to the same page (the picker open again), with no old calendar outcome in the address', () => {
    expect(returnPathFrom('/messages/c1', '?calendar=failed&calendarProvider=google&x=1', { schedule: '1' })).toBe('/messages/c1?x=1&schedule=1');
    expect(returnPathFrom('/settings', '')).toBe('/settings');
  });

  it('knows each outcome the server sends back, and says each in plain words', () => {
    for (const o of ['finish', 'cancelled', 'failed', 'try_again', 'admin']) expect(isOutcome(o)).toBe(true);
    expect(isOutcome('connected')).toBe(false);
    for (const { text } of Object.values(OUTCOME_MESSAGE)) expect(text).not.toMatch(/error|token|oauth|scope|404|invalid/i);
    expect(hintDismissedKey('u1')).toBe('rsn:calendar-hint-dismissed:u1');
  });
});

describe('the consent words (RSN 10: explicit consent; connecting is not the invitation)', () => {
  const all = CONSENT_LINES.join(' ');
  it('says what is read, what never is, what it is for, that it is optional, how to disconnect, and that it is not the emailed invitation', () => {
    expect(all).toMatch(/only when you are busy or free in your main calendar/);
    expect(all).toMatch(/never sees what your events are: not their titles, who is in them, where they are or any notes/);
    expect(all).toMatch(/Nobody else sees it, not even the person you are meeting/);
    expect(all).toMatch(/optional: you can book meetings without it/);
    expect(all).toMatch(/disconnect at any time in Settings/);
    expect(all).toMatch(/not the calendar invitation REASON emails you/);
    // S8 review M8: nor the calendar file, and Microsoft's own wording is explained.
    expect(all).toMatch(/nor the calendar file you can download from a meeting/);
    expect(CONSENT_MICROSOFT_NOTE).toMatch(/REASON asks it only for when you are busy/);
    expect(code('features/calendar/CalendarConsentSheet.tsx')).toContain("{provider === 'microsoft' && <p");
    expect(all).not.toMatch(/\bsession\b/i);
  });
});

describe('nothing calendar while the server has it off', () => {
  it('every calendar control reads the server\'s switch first and draws nothing while it is off', () => {
    const card = code('features/calendar/CalendarsCard.tsx');
    // Off: nothing until the config answers, then nothing unless the member still has a calendar connected (M5).
    expect(card).toContain('if (!known) return null;');
    expect(card).toContain('if (!on && !(connections.data && connections.data.length > 0)) return null;');
    expect(card).toContain('offered={on && providers.includes(provider)}');
    expect(card).toContain('{on ? CARD_INTRO : CARD_PAUSED}');
    const line = code('features/calendar/SchedulerCalendar.tsx');
    expect(line).toMatch(/if \(!state\.on \|\| state\.connections\.isPending\) return null;/);
    const hooks = code('features/calendar/useCalendar.ts');
    expect(hooks).toMatch(/const on = data\?\.calendar\?\.enabled === true;/);
    // Connections and busy times are never even asked for while it is off.
    expect(hooks).toMatch(/enabled: enabled && !!me,\n\s*retry: \(count, err\) => statusOf\(err\) !== 404 && count < 2,\n\s*meta: \{ entities: me \? \[E\.userCalendars\(me\)\] : \[\] \}/);
    expect(code('features/calendar/SchedulerCalendar.tsx')).toContain('const connections = useCalendarConnections(on);');
    expect(hooks).toMatch(/enabled: on && !!me,\n\s*staleTime: 4 \* 60 \* 1000,/);
  });

  it('Settings shows the card and the picker its line, and the shell watches for the way back', () => {
    expect(code('features/settings/SettingsPage.tsx')).toContain('<CalendarsCard />');
    expect(code('features/messages/MeetingScheduler.tsx')).toContain('<SchedulerCalendarLine state={calendar} />');
    expect(code('features/reason/shell/ReasonShell.tsx')).toContain('<CalendarReturnWatcher />');
  });
});

describe('busy is a hint, never a block, and booking never needs a calendar', () => {
  it('a busy cell is striped and labelled but keeps its press and is never disabled', () => {
    const grid = code('features/messages/SchedulerSlotGrid.tsx');
    expect(grid).toContain("const isBusy = busy?.has(key) === true;");
    expect(grid).toContain('onClick={() => onPress(state, key)}');
    expect(grid).not.toMatch(/disabled=\{[^}]*isBusy/);
    expect(grid).toMatch(/isBusy \? 'rsn-busy-stripes' : ''/);
    expect(grid).toContain("aria-label={cellAriaLabel(state, labels[i]) + (isBusy ? BUSY_ARIA_SUFFIX : '')}");
  });

  it('saving times and confirming a meeting do not read a calendar', () => {
    for (const rel of ['features/messages/useSchedulerActions.ts', 'features/messages/useSchedulerDraft.ts', 'features/messages/scheduler-flow.ts']) {
      expect([rel, /features\/calendar|\.\.\/calendar\/|useCalendar|busyKeys/.test(code(rel))]).toEqual([rel, false]);
    }
  });

  it('the only calendar read in the picker is the member\'s own: no other member\'s id is ever sent', () => {
    const hooks = code('features/calendar/useCalendar.ts');
    expect(hooks).toContain("api.get('/calendar/busy', { params: { from: range.from, to: range.to, tz: zone } })");
    expect(code('features/calendar/SchedulerCalendar.tsx')).not.toMatch(/partnerId|otherUserId|theirs/);
  });
});

describe('the flow: consent first, a full-page trip, finished by whoever is signed in', () => {
  it('Connect opens the consent sheet; only its Continue asks the server for the start address', () => {
    const card = code('features/calendar/CalendarsCard.tsx');
    expect(card).toContain('onConnect={() => setConsentFor(provider)}');
    expect(card).not.toContain('useConnectCalendar');
    const sheet = code('features/calendar/CalendarConsentSheet.tsx');
    expect(sheet).toContain("import Sheet from '@/features/reason/ui/Sheet';");
    expect(sheet).toContain('connect.mutate({ provider, returnTo }');
    expect(code('features/calendar/useCalendar.ts')).toContain('window.location.assign(url)');
    expect(code('features/calendar/useCalendar.ts')).not.toMatch(/window\.open/);
  });

  it('disconnect asks first, through the app\'s ConfirmDialog', () => {
    const card = code('features/calendar/CalendarsCard.tsx');
    expect(card).toContain('onDisconnect={() => setConfirming(provider)}');
    expect(card).toMatch(/<ConfirmDialog[\s\S]*tone="danger"[\s\S]*onConfirm=\{confirmDisconnect\}/);
  });

  it('the way back finishes a ticket once, says the outcome, and takes the calendar words out of the address', () => {
    const w = code('features/calendar/CalendarReturnWatcher.tsx');
    expect(w).toContain("const CALENDAR_PARAMS = ['calendar', 'calendarProvider', 'calendarTicket'] as const;");
    expect(w).toMatch(/if \(!on \|\| handled\.current === seen\) return;/);
    // M3: nothing until the switch is known, and nothing said or finished while it is off (the words still leave).
    expect(w).toContain('if (!isOutcome(outcome) || !known) return;');
    expect(w).toMatch(/\{ replace: true \}/);
    expect(w).toContain('finish.mutate({ provider, ticket }');
  });

  it('a connect or disconnect reads this tab again at once, by the entity tag, never by hand-editing the cache', () => {
    const hooks = code('features/calendar/useCalendar.ts');
    expect(hooks.match(/invalidateEntities\(qc, \[E\.userCalendars\(me\)\]\)/g)).toHaveLength(2);
    expect(hooks).not.toContain('setQueryData');
  });

  it('every tap target is at least 44px', () => {
    const line = code('features/calendar/SchedulerCalendar.tsx');
    expect(line).toContain("const LINK = 'inline-flex min-h-[44px] items-center");
    expect(line).toContain('grid h-11 w-11 place-items-center');
    expect(code('features/calendar/CalendarConsentSheet.tsx')).toContain('min-h-[44px]');
    expect(code('features/calendar/CalendarsCard.tsx')).not.toMatch(/size="sm"/);
  });

  it('the client tag matches the server\'s', () => {
    const tag = /userCalendars: \(userId: string\) => `user:\$\{userId\}:calendars`/;
    expect(read('realtime/entities.ts')).toMatch(tag);
    expect(fs.readFileSync(path.join(__dirname, '../../realtime/entities.ts'), 'utf8')).toMatch(tag);
    expect(fs.readFileSync(path.join(__dirname, '../../../../ENTITIES.md'), 'utf8')).toContain('`user:<userId>:calendars`');
  });
});

describe('S8 fix round 1', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
  const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

  it('I2: knows where Google and Microsoft sign-in cannot work: the iPhone home-screen app and other apps\' browsers', () => {
    expect(blockedBrowser(IPHONE, false)).toBeNull();
    expect(blockedBrowser(IPHONE, true)).toBe('ios-home-screen');
    expect(blockedBrowser(ANDROID_CHROME, false)).toBeNull();
    expect(blockedBrowser(ANDROID_CHROME, true)).toBeNull();
    expect(blockedBrowser(`${IPHONE} WhatsApp/24.1`, false)).toBe('in-app');
    expect(blockedBrowser(`${IPHONE} [FBAN/FBIOS;FBAV/480.0]`, false)).toBe('in-app');
    expect(blockedBrowser(`${IPHONE} Instagram 300.0`, false)).toBe('in-app');
    expect(blockedBrowser(`${IPHONE} LinkedInApp`, false)).toBe('in-app');
    expect(blockedBrowser('Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36', false)).toBe('in-app');
    expect(openInBrowserLabel('ios-home-screen', false)).toBe('Open in Safari');
    // N2: an iPad's home-screen app reports a Mac; a real Mac (no touch) is never blocked.
    const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
    expect(blockedBrowser(IPAD, true, 5)).toBe('ios-home-screen');
    expect(blockedBrowser(IPAD, true, 0)).toBeNull();
    expect(appleMobile(IPAD, 5)).toBe(true);
    expect(appleMobile(ANDROID_CHROME, 5)).toBe(false);
    expect(openInBrowserLabel('in-app', true)).toBe('Open in your browser');
  });

  it('I2: the link to carry on opens Settings with the sheet for that provider, and an Android intent opens it in a browser', () => {
    expect(continueUrl('https://app.rsn.network', 'google')).toBe('https://app.rsn.network/settings?calendarConnect=google');
    expect(androidBrowserUrl('https://app.rsn.network/settings?calendarConnect=microsoft'))
      .toBe('intent://app.rsn.network/settings?calendarConnect=microsoft#Intent;scheme=https;end');
    const sheet = code('features/calendar/CalendarConsentSheet.tsx');
    expect(sheet).toContain('const blocked = useMemo(() => blockedBrowser(navigator.userAgent, isStandalone(), navigator.maxTouchPoints), []);');
    expect(sheet).toContain('data-testid="calendar-open-in-browser"');
    expect(sheet).toMatch(/blocked \? \(/);
    // N2: on an iPhone or iPad, Copy link leads (filled, last) and Open in Safari is second.
    expect(sheet).toContain('const copyFirst = useMemo(() => appleMobile(navigator.userAgent, navigator.maxTouchPoints), []);');
    expect(sheet).toContain('copyFirst ? <>{openLink}{copyButton}</> : <>{copyButton}{openLink}</>');
    expect(sheet).toContain("className={cn(BUTTON, copyFirst ? PRIMARY : SECONDARY)}");
    const card = code('features/calendar/CalendarsCard.tsx');
    expect(card).toContain("const asked = params.get('calendarConnect');");
    expect(card).toContain("const alreadyActive = connections.data?.some((c) => c.provider === asked && c.status === 'active');");
    expect(card).toContain('if (on && (providers as string[]).includes(asked) && !alreadyActive) setConsentFor(asked as CalendarProvider);');
  });

  it('I1: the consent says how long busy times are kept, in the same words as the owner checklist', () => {
    expect(CONSENT_LINES).toContain(CONSENT_KEEP);
    // The checklist lives in the private workspace beside the repo (not in CI): checked where it is present.
    const checklistPath = path.join(__dirname, '../../../../../RSN/workspace/assets/Calendar_setup_for_Ali.md');
    if (fs.existsSync(checklistPath)) expect(fs.readFileSync(checklistPath, 'utf8')).toContain(CONSENT_KEEP);
  });

  it('I3: a calendar our own setup cannot read says "Calendar isn\'t available right now"', () => {
    expect(PICKER_UNAVAILABLE).toBe('Calendar isn\'t available right now. Times are shown without it.');
  });

  it('M2: back from the provider (bfcache) the consent sheet starts again', () => {
    const sheet = code('features/calendar/CalendarConsentSheet.tsx');
    expect(sheet).toContain("const onShow = (e: PageTransitionEvent) => { if (e.persisted) connect.reset(); };");
    expect(sheet).toContain("window.addEventListener('pageshow', onShow);");
  });
});

