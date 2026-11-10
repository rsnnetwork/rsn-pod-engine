// ─── Everyone (10 Nov 2026), the browsable list: the row drawn in each request state, and the page read for its rules ──

import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadClientModule, readClientSource } from './load-client-module';

const link = {
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) => createElement('a', { href: to, ...rest }, children),
  useNavigate: () => () => undefined,
};

const card = () => loadClientModule('features/reason/people/EveryoneCard.tsx', {
  'react-router-dom': link,
  '@/components/ui/Avatar': { __esModule: true, default: () => null },
}).default as (props: Record<string, unknown>) => JSX.Element;

const person = (over: Record<string, unknown> = {}) => ({
  id: 'u-1', displayName: 'Amy Tostenson', firstName: 'Amy', lastName: 'Tostenson', avatarUrl: null, bannerUrl: null, bio: null,
  company: 'Acme', jobTitle: 'Founder', industry: null, location: null, linkedinUrl: null, languages: [], professionalRole: [],
  expertiseText: null, whatICanHelpWith: null, pokeStatus: null, pokeSentByOwner: null, relationship: 'none', ...over,
});
const draw = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(card(), { person: person(over), onMeet: () => undefined }));

describe('an Everyone row', () => {
  it('shows the name, role and company, a profile link and "I want to meet" for someone with no request', () => {
    const html = draw();
    expect(html).toContain('Amy Tostenson');
    expect(html).toContain('Founder · Acme');
    expect(html).toContain('href="/people/u-1?from=People"');
    expect(html).toContain('View profile');
    expect(html).toContain('I want to meet');
  });

  it.each([
    ['requested', 'Request sent'],
    ['incoming', 'Respond'],
    ['connected', 'Message'],
    ['met', 'Message'],
    ['declined', 'Request declined'],
  ])('relationship %s: the button reads %s, and never offers a second request', (relationship, label) => {
    const html = draw({ relationship });
    expect(html).toContain(label);
    expect(html).not.toContain('I want to meet');
  });

  it('a request already sent is not pressable', () => {
    expect(draw({ relationship: 'requested' })).toContain('aria-disabled="true"');
    expect(draw({ relationship: 'none' })).not.toContain('aria-disabled');
  });

  it('a member with no name is worded, and both buttons are 44px tall', () => {
    const html = draw({ displayName: '  ' });
    expect(html).toContain('Member');
    expect(html.match(/min-h-\[44px\]/g)?.length).toBe(2);
  });
});

describe('the Everyone page', () => {
  const page = readClientSource('features/reason/people/EveryonePage.tsx');

  it('pages with useInfiniteQuery on the cursor, and declares the people entity tags', () => {
    expect(page).toMatch(/useInfiniteQuery\(/);
    expect(page).toMatch(/getNextPageParam: \(last\) => last\.nextCursor \?\? undefined/);
    expect(page).toMatch(/meta: \{ entities: userId \? \[E\.user\(userId\), E\.userInvites\(userId\), E\.userDms\(userId\), E\.userBlocks\(userId\)\] : \[\] \}/);
  });

  it('debounces the search by 300 ms and keeps it in the query key', () => {
    expect(page).toMatch(/useDebouncedValue\(typed\.trim\(\), 300\)/);
    expect(page).toMatch(/queryKey: reasonKeys\.everyone\(search\)/);
  });

  it('has a skeleton, an empty state, an error state with Try again, and Load more', () => {
    expect(page).toContain('<Skeleton');
    expect(page).toContain('No one matches that search');
    expect(page).toContain('Try again');
    expect(page).toContain('Load more');
    expect(page).toMatch(/if \(!isFetchingNextPage\) void fetchNextPage\(\)/);
  });

  it('starts a request through the Meet sheet', () => {
    expect(page).toMatch(/<MeetSheet person=\{meeting\}/);
  });

  it('the search box is 16px text so a phone does not zoom, and is 44px tall', () => {
    expect(page).toMatch(/min-h-\[44px\][^"]*text-base/);
  });

  it('App routes /people/everyone inside the shell', () => {
    const app = readClientSource('App.tsx');
    const shellRoutes = app.slice(app.indexOf('<ReasonShell />'), app.indexOf('{/* Protected without layout'));
    expect(shellRoutes).toContain('<Route path="/people/everyone" element={<EveryonePage />} />');
  });
});
