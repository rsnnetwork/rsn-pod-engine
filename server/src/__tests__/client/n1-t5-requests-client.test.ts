// ─── The 30 Oct requests work on the preview, drawn (items 3.1–3.4, 4.1, 4.2) ────────────────────
//
// Each component here is run and drawn to markup, not read as text: the request card in both forms, the
// introduction card in the conversation, read by each of the two people, and the hero's Message button.

import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { iconStandIns, loadClientModule, readClientSource } from './load-client-module';

const link = {
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) => createElement('a', { href: to, ...rest }, children),
  useNavigate: () => () => undefined,
};
const SHRADHA = 'u-shradha';
const STEFAN = 'u-stefan';

describe('the meeting request card (3.1, 3.2)', () => {
  // The note's "Show more" measures itself in a layout effect, which a markup render cannot run: React says so once
  // per draw, and that warning is all that is let through silently.
  beforeEach(() => {
    const original = console.error;
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('useLayoutEffect does nothing on the server')) return;
      original(...args);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const card = () => loadClientModule('features/messages/MeetingRequestCard.tsx', {
    'react-router-dom': link,
    'lucide-react': iconStandIns,
    '@/components/ui/Avatar': { __esModule: true, default: () => null },
    '@/components/ui/ProfileLink': {
      __esModule: true,
      default: ({ userId, children, className }: { userId: string; children?: ReactNode; className?: string }) =>
        createElement('a', { href: `/people/${userId}`, className }, children),
    },
    '@/stores/toastStore': { useToastStore: () => () => undefined },
    './useRequestAnswer': { useRequestAnswer: () => ({ answer: () => undefined, busy: false, answering: null }) },
  }).default as (props: Record<string, unknown>) => JSX.Element;

  const request = (over: Record<string, unknown> = {}) => ({
    id: 'p1', senderId: SHRADHA, message: 'legacy text', createdAt: '2026-10-30T10:00:00Z',
    senderFirstName: 'Shradha', senderDisplayName: 'Shradha Adhikari', senderAvatarUrl: null,
    senderJobTitle: 'Founder', senderCompany: 'Vokt', preferredFormat: 'video_20',
    note: 'I think we have a useful reason to speak.', reasonLine: 'Shradha is looking to meet founders, and Stefan is a Founder.',
    ...over,
  });
  const draw = (variant: 'list' | 'focused', over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(card(), { request: request(over), variant }));

  it.each(['list', 'focused'] as const)('%s: the heading in REASON\'s voice, the person, the note as a quote, then REASON\'s line in its own box', (variant) => {
    const html = draw(variant);
    const at = (s: string) => html.indexOf(s);
    expect(html).toContain('Shradha wants to meet you');
    expect(html).toContain('Shradha Adhikari');
    expect(html).toContain('Founder · Vokt');
    expect(html).toMatch(/Shradha(&#x27;|’|&rsquo;)s note/);
    expect(html).toMatch(/<blockquote[^>]*>[\s\S]*I think we have a useful reason to speak\.[\s\S]*<\/blockquote>/);
    expect(html).toMatch(/data-testid="reason-line"[\s\S]*Why REASON suggested this[\s\S]*Shradha is looking to meet founders, and Stefan is a Founder\./);
    // REASON's line is outside the quote, and nothing of it reads as the member's.
    expect(html.slice(at('<blockquote'), at('</blockquote>'))).not.toContain('Why REASON');
    expect(at('wants to meet you')).toBeLessThan(at('Shradha Adhikari'));
    expect(at('</blockquote>')).toBeLessThan(at('data-testid="reason-line"'));
    expect(html).toContain('Prefers 20 minute video conversation');
    expect(html).toContain('Accept');
    expect(html).toContain('Decline');
    expect(html).not.toContain('legacy text');
  });

  it('only the focused form has "View full profile", as its own 44px row', () => {
    expect(draw('focused')).toMatch(/class="mt-1 flex min-h-\[44px\] w-fit items-center[^"]*"[^>]*>View full profile/);
    expect(draw('list')).not.toContain('View full profile');
  });

  it('with neither a note nor a line: only the heading, the person and the answers', () => {
    const html = draw('list', { note: null, reasonLine: null });
    expect(html).toContain('Shradha wants to meet you');
    expect(html).not.toMatch(/s note|blockquote|reason-line/);
  });

  it('a server from before 30 Oct sends only message: it is shown as before, with no "note" heading', () => {
    const html = draw('list', { note: undefined, reasonLine: undefined, message: 'Old one text.' });
    expect(html).toContain('Old one text.');
    expect(html).not.toMatch(/s note|reason-line/);
  });

  it('no first name: the first word of the name, never "null wants to meet you"', () => {
    expect(draw('list', { senderFirstName: null })).toContain('Shradha wants to meet you');
    expect(draw('list', { senderFirstName: null, senderDisplayName: null })).toContain('A member wants to meet you');
  });

  it('wraps every text inside the card, and pulls no tap box over another line', () => {
    const src = readClientSource('features/messages/MeetingRequestCard.tsx');
    expect((src.match(/\[overflow-wrap:anywhere\]/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(src).not.toMatch(/(?:^|[\s"'])-m[trblxy]?-|\brelative\b|\btruncate\b/m);
  });
});

describe('the introduction card in the conversation (3.2)', () => {
  const systemCard = () => loadClientModule('features/messages/SystemMessageCard.tsx', {
    'react-router-dom': link,
    'lucide-react': iconStandIns,
    '@/components/brand/SheepAvatar': { __esModule: true, default: () => createElement('i', { 'data-sheep': 'yes' }) },
    // The meeting card's Add to calendar (T7) reaches the browser's storage when loaded; the introduction card uses none of it.
    '@/components/calendar/AddToCalendar': { __esModule: true, default: () => null },
    '@/components/calendar/calendar-links': { meetingEntry: () => null },
    '@/components/calendar/calendar-files': { conversationMeetingFile: () => null, meetingFile: () => null },
  }).default as (props: Record<string, unknown>) => JSX.Element;
  const meta = (reasonLine: string | null) => ({ type: 'introduction', requesterId: SHRADHA, recipientId: STEFAN, reasonLine });
  const CONTENT = 'Shradha asked to meet Stefan, and Stefan accepted. Why REASON suggested this: A line.';
  const draw = (viewerId: string, partnerName: string, reasonLine: string | null = 'A line.') =>
    renderToStaticMarkup(createElement(systemCard(), { content: CONTENT, meta: meta(reasonLine), viewerId, partnerName }));

  it('the person who was asked reads "Shradha wanted to meet you. You accepted.", then REASON\'s line', () => {
    const html = draw(STEFAN, 'Shradha');
    expect(html).toContain('Shradha wanted to meet you. You accepted.');
    expect(html).toMatch(/Why REASON suggested this[\s\S]*A line\./);
    expect(html).toContain('data-card="introduction"');
  });

  it('the person who asked reads "You asked to meet Stefan. Stefan accepted."', () => {
    expect(draw(SHRADHA, 'Stefan')).toContain('You asked to meet Stefan. Stefan accepted.');
  });

  it('with no line there is no box; anyone else, or with no name to use, reads the card\'s own words', () => {
    expect(draw(STEFAN, 'Shradha', null)).not.toContain('data-testid="reason-line"');
    expect(draw('u-admin', 'Someone')).toContain(CONTENT.split(' Why')[0]);
    expect(draw(STEFAN, '')).toContain('Shradha asked to meet Stefan, and Stefan accepted.');
  });

  it('the thread hands the card who is reading and the other person\'s first name', () => {
    const page = readClientSource('features/messages/MessagesPage.tsx');
    expect(page).toMatch(/viewerId=\{myUserId\}\n\s*partnerName=\{headerContext\?\.otherDisplayName\?\.trim\(\)\.split\(\/\\s\+\/\)\[0\]\}/);
  });
});

describe('the hero\'s Message button (4.1) and the labels (4.2)', () => {
  const actions = () => loadClientModule('features/reason/human/ProfileHeroActions.tsx', {
    'react-router-dom': link,
    'lucide-react': iconStandIns,
  }).default as (props: Record<string, unknown>) => JSX.Element | null;
  const brief = (state: string, canMessage: boolean, canMessageReason: string | null = null) =>
    ({ relationship: { state }, canMessage, canMessageReason });
  const draw = (b: ReturnType<typeof brief>) => renderToStaticMarkup(createElement(actions(), { brief: b, userId: STEFAN }));

  // Shirley pilot S5 (12 Nov 2026): with ?compose=1, so the chat opens with the cursor in the box.
  it.each(['connected', 'met'])('%s and allowed: a red 44px Message to /messages/new/:userId?compose=1', (state) => {
    const html = draw(brief(state, true));
    expect(html).toMatch(/<a href="\/messages\/new\/u-stefan\?compose=1" class="[^"]*\bmin-h-\[44px\][^"]*\bbg-reason-red\b[^"]*"[\s\S]*Message<\/a>/);
  });

  it('refused as not mutual: the sentence, and never a dead button', () => {
    const html = draw(brief('met', false, 'not_mutual'));
    expect(html).toContain('Messages open when you both say you would meet again');
    expect(html).not.toMatch(/<a |<button/);
  });

  it('refused for another reason: nothing at all', () => {
    expect(draw(brief('connected', false, 'no_encounter'))).toBe('');
  });

  it.each(['none', 'requested', 'incoming', 'declined'])('%s: no Message button, even for an admin the server would let message anyone', (state) => {
    expect(draw(brief(state, true))).toBe('');
  });

  it('Continue is Message now, with its key kept, and the next moves are about messaging', () => {
    const labels = loadClientModule('features/reason/human/labels.ts', {}) as {
      PRIMARY_LABEL: Record<string, string>; NEXT_MOVE: Record<string, string>;
    };
    expect(labels.PRIMARY_LABEL.continue).toBe('Message');
    expect(labels.NEXT_MOVE.connected).toMatch(/^Message them/);
    expect(labels.NEXT_MOVE.met).toMatch(/message them/);
    expect(Object.values(labels.PRIMARY_LABEL)).not.toContain('Continue');
  });

  it('"What happens next" on a connection\'s profile says what is left to do', () => {
    expect(readClientSource('features/reason/human/ProfileDetails.tsx'))
      .toMatch(/`You are connected\. Message \$\{first\}, meet, and record what came of it\.`/);
  });
});
