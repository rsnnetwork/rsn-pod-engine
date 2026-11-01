// ─── An event for a whole circle, on the preview (T13, 1 Nov 2026; 30 Oct review 6.5, L20) ─────────────────────────
// "It should be possible to create an event for a whole Circle." The circle's managers schedule from the circle page;
// the form opens with the circle preset (who it is for, its pods first, private meaning the circle); the event page
// says who it is for and links the circle; Duplicate keeps the circle. The pure rules run here; the screens are
// pinned by what they must hold.

import * as fs from 'fs';
import * as path from 'path';
import {
  circleForLine, circleGate, circlePrivateSummary, duplicateCircleField, eventCircleLine, membersWord, podsForCircle,
  possessive, scheduleForCircleHref,
} from '../../../../client/src/features/sessions/circle-preset';
import { circleEntities } from '../../../../client/src/features/circles/circle-logic';

const SRC = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

describe('the circle preset (pure)', () => {
  it('says who the event is for, with the member count in words', () => {
    expect(circleForLine('Founders', 9)).toBe('For everyone in Founders · 9 members');
    expect(circleForLine('Doctors', 1)).toBe('For everyone in Doctors · 1 member');
    expect(membersWord(0)).toBe('0 members');
  });

  it('the private choice names the circle, with a possessive that reads right after an s', () => {
    expect(circlePrivateSummary('Founding Circle')).toBe("Only Founding Circle's members and people you invite.");
    expect(circlePrivateSummary('AI Developers')).toBe("Only AI Developers' members and people you invite.");
    expect(possessive('Founders ')).toBe("Founders'");
  });

  it('lists the circle\'s pods you run first, then your other pods, each in its own order', () => {
    const pods = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    expect(podsForCircle(pods, ['c', 'a', 'zzz'])).toEqual({ inCircle: [{ id: 'a' }, { id: 'c' }], others: [{ id: 'b' }, { id: 'd' }] });
    expect(podsForCircle(pods, [])).toEqual({ inCircle: [], others: pods });
  });

  it('opens the form from the circle, and says who an event is for on its page', () => {
    expect(scheduleForCircleHref('c 1')).toBe('/sessions/new?circleId=c%201');
    expect(eventCircleLine('Founders')).toBe('For Founders');
  });

  it('decides the form from the circle: wait, could not open, not yours to schedule, or go', () => {
    expect(circleGate({ isLoading: true })).toBe('loading');
    expect(circleGate({ isLoading: false, circle: undefined })).toBe('missing');
    expect(circleGate({ isLoading: false, circle: { canManage: false } })).toBe('refused');
    expect(circleGate({ isLoading: false, circle: { canManage: true } })).toBe('ok');
    expect(circleGate({ isLoading: false, circle: { canManage: undefined } })).toBe('refused');
  });

  it('a copy keeps the circle the event is for (and an event with none sends none, as production\'s copy)', () => {
    expect(duplicateCircleField({ circleId: 'c1' })).toEqual({ circleId: 'c1' });
    expect(duplicateCircleField({ circleId: null })).toEqual({});
    expect(duplicateCircleField({})).toEqual({});
  });
});

describe('the circle page', () => {
  const page = read('features/circles/CircleDetailPage.tsx');
  const events = read('features/circles/CircleEventsSection.tsx');

  it('offers Schedule an event to the people who run it (canManage), in the header\'s row of actions, opening the preset form', () => {
    expect(page).toMatch(/\{circle\.canManage && \(\s*<Link\s+to=\{scheduleForCircleHref\(circle\.id\)\}[^>]*data-testid="circle-schedule-event"[^>]*className=\{HEADER_ACTION\}/);
    expect(page).toMatch(/<CalendarPlus className="h-4 w-4" \/> Schedule an event/);
  });

  it('follows the member\'s own events too, so a new circle event shows without a refresh', () => {
    expect(circleEntities('c1', 'me')).toEqual(['circle:c1', 'circle:c1:members', 'user:me:circles', 'user:me', 'user:me:sessions']);
    expect(circleEntities('c1', undefined)).toEqual(['circle:c1', 'circle:c1:members']);
    expect(page).toMatch(/meta: \{ entities: circleEntities\(circleId \?\? '', user\?\.id\) \}/);
  });

  it('lists the circle\'s events and its pods\' (the server decides who sees which), marks the circle\'s own, and says when there are none', () => {
    expect(page).toMatch(/\{!circle\.locked && <CircleEventsSection circle=\{circle\} \/>\}/);
    expect(events).toMatch(/<div className="grid grid-cols-1 gap-2">\s*\{circle\.upcomingEvents\.map/);
    expect(events).toMatch(/e\.forCircle && /);
    expect(events).toContain('For this circle');
    expect(events).toContain('No upcoming events yet.');
    expect(events).toMatch(/min-h-\[44px\]/);
  });
});

describe('the event form with a circle', () => {
  const form = read('features/sessions/CreateSessionPage.tsx');
  const access = read('features/sessions/EventAccessField.tsx');

  it('reads ?circleId=, follows the circle\'s tags, and goes back to the circle', () => {
    expect(form).toMatch(/params\.get\('circleId'\)/);
    expect(form).toMatch(/queryKey: \['circle', fromCircleId\]/);
    expect(form).toMatch(/meta: \{ entities: fromCircleId \? circleEntities\(fromCircleId, userId\) : \[\] \}/);
    expect(form).toMatch(/`\/circles\/\$\{fromCircleId\}`/);
  });

  it('says why when the circle cannot be opened or is not theirs to schedule, and keeps "No pod to schedule in yet"', () => {
    expect(form).toContain("We couldn't open that circle");
    expect(form).toMatch(/Only the people who run \$\{[^}]+\} can schedule an event for it\./);
    expect(form).toContain('No pod to schedule in yet');
  });

  it('shows who it is for, lists the circle\'s pods first, starts private and sends the circle', () => {
    expect(form).toMatch(/data-testid="event-circle-preset"/);
    expect(form).toMatch(/circleForLine\(circle\.name, circle\.memberCount\)/);
    expect(form).toMatch(/podsForCircle\(pods, circle\?\.pods\.map\(\(p\) => p\.podId\) \?\? \[\]\)/);
    expect(form).toMatch(/<optgroup label=\{`In \$\{circle\.name\}`\}>/);
    expect(form).toMatch(/<optgroup label="Your other pods">/);
    expect(form).toMatch(/chosenVisibility \?\? \(circle \? 'private' : defaultEventVisibility\(pod\?\.visibility\)\)/);
    expect(form).toMatch(/\.\.\.\(circle \? \{ circleId: circle\.id \} : \{\}\)/);
    expect(form).toMatch(/circleName=\{circle\?\.name\}/);
    expect(access).toMatch(/key === 'private' && circleName \? circlePrivateSummary\(circleName\) : rule\.summary/);
  });
});

describe('the event page', () => {
  const detail = read('features/sessions/SessionDetailPage.tsx');

  it('says who it is for and links the circle', () => {
    expect(detail).toMatch(/\{session\.circle && \(\s*<Link to=\{`\/circles\/\$\{session\.circle\.id\}`\}[^>]*data-testid="event-circle"[^>]*min-h-\[44px\]/);
    expect(detail).toMatch(/\{eventCircleLine\(session\.circle\.name\)\}/);
  });

  it('Duplicate keeps the circle, and a refusal reads in the server\'s words', () => {
    expect(detail).toMatch(/\.\.\.duplicateCircleField\(session \?\? \{\}\),/);
    expect(detail).toMatch(/onError: \(err: unknown\) => addToast\(circleErrorSentence\(err, 'Failed to duplicate event'\), 'error'\)/);
  });
});
