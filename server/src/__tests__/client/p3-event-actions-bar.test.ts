// server/src/__tests__/client/p3-event-actions-bar.test.ts
// The event page's actions are ONE bar (11 Nov 2026, the product owner circled the gap with "???"). Before, Go Live and
// Add to calendar sat on the left of one row and the organiser's tools (Matching board, Invite people, Copy, Edit, End
// event) dropped to a second row pushed to the far right with `ml-auto`, leaving an empty gap. Now every action is a
// child of one flex-wrap row: the primary actions first, then the organiser's tools, all left-aligned, one gap apart,
// 44px tall; on a phone they wrap line by line. Every button keeps its condition and its test id.
// The headed check (1280px: the tools on the same line as Go Live) is in e2e/tests/p3-matching-questions.spec.ts.
import { readClientSource } from './load-client-module';

const page = readClientSource('features/sessions/SessionDetailPage.tsx');

/** The action bar's own markup: from its opening tag to the organiser settings that follow it. */
function actionBar(): string {
  const start = page.indexOf('data-testid="event-actions"');
  const end = page.indexOf('{/* Part 2 Task 11: the organiser\'s settings', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return page.slice(page.lastIndexOf('<div', start), end);
}

describe('the event page has one action bar', () => {
  it('is one flex-wrap row, left-aligned, with one gap', () => {
    expect(page.match(/data-testid="event-actions"/g)).toHaveLength(1);
    expect(page).toContain('<div data-testid="event-actions" className="flex flex-wrap items-center gap-3 animate-fade-in-up stagger-1">');
  });

  it('pushes nothing to the right: no ml-auto, no second row, no column wrapper', () => {
    const bar = actionBar();
    expect(bar).not.toMatch(/ml-auto/);
    expect(bar).not.toMatch(/justify-end|justify-between/);
    expect(bar).not.toMatch(/flex-col/);
    // The only <div> in the bar is the bar itself and the Registered chip; the organiser tools are a fragment.
    expect(bar.match(/<div\b/g)).toHaveLength(3);
    expect(bar.match(/data-testid="event-registered"/g)).toHaveLength(2);
    expect(page).not.toContain('<div className="flex flex-col gap-3 animate-fade-in-up stagger-1">');
  });

  it('holds every action, primary first, then the organiser tools, each with its condition', () => {
    const bar = actionBar();
    const order = [
      '<EventAccessActions',
      "{isHost ? 'Go Live' : 'Enter Event'}",
      '<Play className="h-4 w-4 mr-2" /> Enter Live Event',
      '<AddToCalendar',
      "{isRoundsEvent ? 'View recap' : 'Who took part'}",
      'data-testid="matching-board-link"',
      'Invite people',
      'title="Duplicate this event"',
      'title="Edit event"',
      // The owner's order for the tools: Matching board, Invite people, Copy, Edit, End event.
      '{mayEndForEveryone && sessionId && <EndEventButton sessionId={sessionId} />}',
    ];
    const at = order.map((s) => bar.indexOf(s));
    for (const [i, s] of order.entries()) expect({ s, found: at[i] > -1 }).toEqual({ s, found: true });
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(bar).toContain("{(isHost || isAdmin || mayInvite || mayPlanMeetings) && sessionStatusPhase(session.status) !== 'cancelled' && (");
    expect(bar).toContain("{hasRoom && (isRegistered || isHost) && sessionStatusPhase(session.status) === 'pre' && !isDraft && (");
    expect(bar).toContain("{session.status === 'scheduled' && session.scheduledAt && !isDraft && (");
  });

  it('every control in it is 44px tall', () => {
    const bar = actionBar();
    // Raw elements state min-h-[44px]; <Button> is 44px at its default size (min-h-[44px] in Button.tsx).
    const opens = ['<button', '<Link', '<div data-testid="event-registered"', '<AddToCalendar'];
    let checked = 0;
    for (const open of opens) {
      for (let at = bar.indexOf(open); at > -1; at = bar.indexOf(open, at + 1)) {
        const tag = bar.slice(at, bar.indexOf('className=', at) + 120);
        expect({ open, tall: tag.includes('min-h-[44px]') }).toEqual({ open, tall: true });
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(7);
    expect(bar).not.toMatch(/<Button[^>]*size="sm"/);
    expect(readClientSource('components/ui/Button.tsx')).toContain("md: 'px-4 py-2 text-sm min-h-[44px]'");
  });
});
